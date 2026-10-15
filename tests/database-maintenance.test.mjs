import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, delimiter } from "node:path";
import { randomBytes } from "node:crypto";

test(
  "table drafts use bound values, conflict checks and atomic savepoints in a real transaction",
  {
    skip: !process.env.UTERM_DATABASE_WRITE_TEST,
    timeout: 90000,
  },
  async () => {
    const host = process.env.UTERM_MYSQL_HOST || "127.0.0.1";
    const port = Number(process.env.UTERM_MYSQL_PORT);
    const database = process.env.UTERM_MYSQL_DATABASE || "";
    assert.ok(
      ["127.0.0.1", "::1"].includes(host) &&
        port > 0 &&
        port !== 3306 &&
        /^uterm_[a-z0-9_]+$/.test(database),
      "Write tests require an explicit disposable loopback database and nonstandard port",
    );
    function worker() {
      const child = spawn(
        process.env.UTERM_DATABASE_JAVA || "java",
        [
          "-Xmx128m",
          "-cp",
          [
            resolve("components/database/engine.jar"),
            resolve("components/database/target/mysql.jar"),
          ].join(delimiter),
          "DatabaseBridge",
        ],
        { stdio: ["pipe", "pipe", "inherit"] },
      );
      const pending = new Map();
      let id = 0;
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const value = JSON.parse(line);
        pending.get(value.id)?.(value);
        pending.delete(value.id);
      });
      return {
        async request(value) {
          return await new Promise((resolve, reject) => {
            const sequence = ++id;
            const timer = setTimeout(() => {
              pending.delete(sequence);
              reject(new Error("QA timeout"));
            }, 35000);
            pending.set(sequence, (reply) => {
              clearTimeout(timer);
              resolve(reply);
            });
            child.stdin.write(JSON.stringify({ ...value, id: sequence }) + "\n");
          });
        },
        close() {
          lines.close();
          child.kill();
        },
      };
    }
    const primary = worker(),
      observer = worker();
    const name = "uterm_grid_" + randomBytes(6).toString("hex");
    const target = { catalog: database, schema: "", table: name };
    const quoted = "`" + database + "`.`" + name + "`";
    const extra = "`" + database + "`.`" + name + "_extra`";
    const ok = async (worker, request) => {
      const reply = await worker.request(request);
      assert.equal(reply.error, null, JSON.stringify(request));
      return reply.result;
    };
    const query = (sql) => ok(primary, { op: "query", sql });
    const table = () => ok(primary, { op: "table", ...target });
    try {
      for (const client of [primary, observer])
        await ok(client, {
          op: "connect",
          config: {
            kind: "mysql",
            host,
            port,
            database,
            username: process.env.UTERM_MYSQL_USER || "root",
            tls: false,
          },
          password: process.env.UTERM_MYSQL_PASSWORD || "",
        });
      assert.equal((await primary.request({ op: "apply", ...target })).error, "DB_READ_ONLY");
      await ok(primary, { op: "writable", enabled: true });
      await query(
        `CREATE TABLE ${quoted} (id INT PRIMARY KEY, name VARCHAR(100) NOT NULL, amount DECIMAL(24,4), notes TEXT) ENGINE=InnoDB`,
      );
      await query(
        `INSERT INTO ${quoted} VALUES (1,'first',12345678901234567890.1234,NULL),(2,'100%_literal',NULL,'original')`,
      );
      await ok(primary, { op: "commit" });
      let snapshot = await table();
      assert.equal(snapshot.table.editable, true);
      assert.equal(snapshot.rows[0][2], "12345678901234567890.1234");
      const literal = "中文' ; DROP TABLE nope; --";
      const update = {
        kind: "update",
        original: snapshot.rows[0],
        values: { name: literal, notes: "" },
      };
      const payload = { ...target, signature: snapshot.table.signature, changes: [update] };
      const preview = await ok(primary, { op: "preview", ...payload });
      assert.ok(!preview.preview[0].sql.includes(literal));
      assert.deepEqual(preview.preview[0].parameters, [literal, "", "1"]);
      assert.equal((await ok(primary, { op: "apply", ...payload })).applied, 1);
      assert.equal(
        (await ok(observer, { op: "query", sql: `SELECT name FROM ${quoted} WHERE id=1` }))
          .rows[0][0],
        "first",
      );
      await ok(primary, { op: "rollback" });
      assert.equal((await table()).rows[0][1], "first");
      await ok(primary, { op: "apply", ...payload });
      await ok(primary, { op: "commit" });
      assert.equal(
        (await ok(observer, { op: "query", sql: `SELECT name FROM ${quoted} WHERE id=1` }))
          .rows[0][0],
        literal,
      );
      await query(`UPDATE ${quoted} SET notes='earlier SQL' WHERE id=2`);
      snapshot = await table();
      const conflict = {
        ...target,
        signature: snapshot.table.signature,
        changes: [
          { kind: "update", original: snapshot.rows[0], values: { name: "must rollback" } },
          { kind: "insert", values: { id: "2", name: "duplicate" } },
        ],
      };
      assert.match((await primary.request({ op: "apply", ...conflict })).error, /^DB_SQL:/);
      const after = await table();
      assert.equal(after.rows[0][1], literal);
      assert.equal(after.rows[1][3], "earlier SQL");
      await ok(primary, { op: "rollback" });
      const stale = {
        ...target,
        signature: snapshot.table.signature,
        changes: [{ kind: "update", original: snapshot.rows[1], values: { name: "stale" } }],
      };
      assert.equal((await primary.request({ op: "apply", ...stale })).error, "DB_CONFLICT");
      assert.equal(
        (await primary.request({ op: "preview", ...payload, signature: "changed" })).error,
        "DB_CONFLICT",
      );
      assert.equal(
        (
          await primary.request({
            op: "preview",
            ...payload,
            changes: [
              { kind: "update", original: after.rows[0], values: { amount: "1e99999999" } },
            ],
          })
        ).error,
        "DB_INVALID_VALUE",
      );
      const filtered = await ok(primary, {
        op: "table",
        ...target,
        filters: [{ column: "name", operator: "contains", value: "%_" }],
      });
      assert.deepEqual(
        filtered.rows.map((row) => row[0]),
        ["2"],
      );
      const inserted = await ok(primary, {
        op: "apply",
        ...payload,
        changes: [{ kind: "insert", values: { id: "3", name: "inserted" } }],
      });
      const row = inserted.rows.find((row) => row[0] === "3");
      await ok(primary, {
        op: "apply",
        ...payload,
        changes: [{ kind: "delete", original: row, values: {} }],
      });
      assert.ok(!(await table()).rows.some((row) => row[0] === "3"));
      await ok(primary, { op: "rollback" });
      assert.equal(
        (await ok(primary, { op: "explain", sql: `SELECT * FROM ${quoted} WHERE id=1` })).columns
          .length > 0,
        true,
      );
      assert.equal(
        (await primary.request({ op: "explain", sql: `DELETE FROM ${quoted}` })).error,
        "DB_READ_ONLY",
      );
      for (const definition of [
        "(value TEXT) ENGINE=InnoDB",
        "(id INT PRIMARY KEY, data BLOB) ENGINE=InnoDB",
        "(id INT PRIMARY KEY) ENGINE=MyISAM",
      ]) {
        await query(`CREATE TABLE ${extra} ${definition}`);
        assert.equal(
          (await ok(primary, { op: "table", ...target, table: name + "_extra" })).table.editable,
          false,
        );
        await query(`DROP TABLE ${extra}`);
      }
    } finally {
      await primary.request({ op: "rollback" }).catch(() => {});
      await primary.request({ op: "query", sql: `DROP TABLE IF EXISTS ${quoted}` }).catch(() => {});
      await primary
        .request({ op: "query", sql: `DROP TABLE IF EXISTS \`${database}\`.\`${name}_extra\`` })
        .catch(() => {});
      primary.close();
      observer.close();
    }
  },
);
