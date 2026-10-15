import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, delimiter } from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";

test(
  "bundled JSON preserves controls, Unicode, nested values and decimal precision",
  {
    skip: !process.env.UTERM_DATABASE_JAVA_TEST,
  },
  () => {
    const bytes = execFileSync(
      process.env.UTERM_DATABASE_JAVA || "java",
      [
        "-cp",
        resolve("components/database/engine.jar"),
        resolve("tests/fixtures/DatabaseJsonProbe.java"),
      ],
      { timeout: 20000 },
    );
    const value = JSON.parse(bytes.toString("utf8"));
    assert.equal(
      value.controls,
      Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join(""),
    );
    assert.equal(value.text, '中文𐐀"\\\n\r\t');
    assert.match(bytes.toString("utf8"), /12345678901234567890\.125/);
    assert.deepEqual(value.nested.slice(0, 2), [null, true]);
  },
);

async function authenticatedProxy(forward = false) {
  const token = randomBytes(16).toString("hex");
  const sockets = new Set();
  let authenticated = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(12000, () => socket.destroy());
    const read = async (size) => {
      let data;
      while ((data = socket.read(size)) === null) await once(socket, "readable");
      return data;
    };
    void (async () => {
      const hello = await read(2);
      assert.equal(hello[0], 5);
      assert.ok((await read(hello[1])).includes(2));
      socket.write(Buffer.from([5, 2]));
      const auth = await read(2);
      assert.equal(auth[0], 1);
      assert.equal((await read(auth[1])).toString(), "uterm");
      const length = (await read(1))[0];
      assert.equal((await read(length)).toString(), token);
      authenticated++;
      socket.write(Buffer.from([1, 0]));
      const header = await read(4);
      const size = header[3] === 3 ? (await read(1))[0] : header[3] === 4 ? 16 : 4;
      await read(size + 2);
      if (!forward) {
        socket.destroy();
        return;
      }
      const remote = createConnection({
        host: process.env.UTERM_MYSQL_HOST || "127.0.0.1",
        port: Number(process.env.UTERM_MYSQL_PORT || 3306),
      });
      sockets.add(remote);
      remote.on("close", () => sockets.delete(remote));
      remote.on("error", () => socket.destroy());
      socket.on("close", () => remote.destroy());
      await once(remote, "connect");
      socket.setTimeout(0);
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      socket.pipe(remote).pipe(socket);
    })().catch(() => socket.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    token,
    count: () => authenticated,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

for (const tunnel of [false, true])
  test(
    `real MySQL worker preserves types, pages results, guards writes and handles transactions${tunnel ? " through authenticated SOCKS" : " directly"}`,
    { skip: !process.env.UTERM_MYSQL_TEST, timeout: 60000 },
    async () => {
      const proxy = tunnel ? await authenticatedProxy(true) : null;
      const child = spawn(
        process.env.UTERM_DATABASE_JAVA || "java",
        [
          "-Xmx128m",
          "-Dfile.encoding=US-ASCII",
          "-cp",
          [
            resolve("components/database/engine.jar"),
            resolve("components/database/target/mysql.jar"),
          ].join(delimiter),
          "DatabaseBridge",
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      const pending = new Map();
      let sequence = 0;
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const value = JSON.parse(line);
        pending.get(value.id)?.(value);
        pending.delete(value.id);
      });
      const request = (value) =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("Worker response timed out"));
          }, 15000);
          pending.set(id, (value) => {
            clearTimeout(timer);
            resolve(value);
          });
          child.stdin.write(JSON.stringify({ ...value, id }) + "\n");
        });
      try {
        const connected = await request({
          op: "connect",
          config: {
            kind: "mysql",
            host: process.env.UTERM_MYSQL_HOST || "127.0.0.1",
            port: Number(process.env.UTERM_MYSQL_PORT || 3306),
            username: process.env.UTERM_MYSQL_USER || "root",
            database: process.env.UTERM_MYSQL_DATABASE || "",
            tls: process.env.UTERM_MYSQL_TLS === "1",
            ca_file:
              process.env.UTERM_MYSQL_CA ||
              (process.env.UTERM_MYSQL_TLS === "1" ? "" : "/unused/tls-disabled.pem"),
          },
          password: process.env.UTERM_MYSQL_PASSWORD || "",
          proxy_port: proxy?.port || 0,
          proxy_token: proxy?.token || "",
        });
        assert.equal(connected.error, null, "MySQL connection must succeed");
        assert.equal(connected.result.protocol, 1);
        const selected = await request({
          op: "query",
          sql: "SELECT NULL AS n, CAST(12345678901234567890 AS DECIMAL(20,0)) AS precise, '中文' AS unicode_text, CAST(X'00FF' AS BINARY) AS bytes",
          offset: 0,
        });
        assert.equal(selected.error, null);
        assert.deepEqual(selected.result.rows[0], [
          null,
          "12345678901234567890",
          "中文",
          { binary: "AP8=", truncated: false },
        ]);
        const large = await request({
          op: "query",
          sql: "SELECT REPEAT('中', 20000) AS long_text",
        });
        assert.equal(large.error, null);
        assert.equal(large.result.rows[0][0], "中".repeat(16384) + " …");
        const denied = await request({ op: "query", sql: "SET @uterm_database_qa = 1" });
        assert.equal(denied.error, "DB_READ_ONLY");
        const catalogs = await request({ op: "metadata", view: "catalogs" });
        assert.equal(catalogs.error, null);
        assert.ok(catalogs.result.columns.some((column) => column.name === "TABLE_CAT"));
        const tables = await request({
          op: "metadata",
          view: "tables",
          catalog: "information_schema",
          schema: "",
        });
        assert.equal(tables.error, null);
        assert.ok(tables.result.rows.length > 0);
        const tableName =
          tables.result.rows[0][
            tables.result.columns.findIndex((column) => column.name === "TABLE_NAME")
          ];
        const columns = await request({
          op: "metadata",
          view: "columns",
          catalog: "information_schema",
          schema: "",
          table: tableName,
        });
        assert.equal(columns.error, null);
        assert.ok(columns.result.rows.length > 0);
        const sql =
          "SELECT a.n + b.n * 10 + c.n * 100 AS n FROM (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a CROSS JOIN (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b CROSS JOIN (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2) c ORDER BY n";
        const first = await request({ op: "query", sql, offset: 0 });
        assert.equal(first.result.rows.length, 200);
        assert.equal(first.result.more, true);
        const second = await request({ op: "query", sql, offset: 200 });
        assert.equal(second.result.rows.length, 100);
        assert.equal(second.result.rows[0][0], "200");
        assert.equal(second.result.more, false);
        assert.equal((await request({ op: "writable", enabled: true })).error, null);
        assert.equal(
          (await request({ op: "query", sql: "SET @uterm_database_qa = 1" })).error,
          null,
        );
        assert.equal((await request({ op: "rollback" })).error, null);
        assert.equal((await request({ op: "commit" })).error, null);
        assert.equal((await request({ op: "writable", enabled: false })).error, null);
        if (proxy) assert.ok(proxy.count() > 0);
        await request({ op: "writable", enabled: true });
        assert.equal(
          (await request({ op: "query", sql: "SET SESSION wait_timeout = 1" })).error,
          null,
        );
        await request({ op: "commit" });
        await new Promise((resolve) => setTimeout(resolve, 1800));
        assert.equal((await request({ op: "query", sql: "SELECT 1" })).error, "DB_DISCONNECTED");
      } finally {
        lines.close();
        child.kill();
        proxy?.close();
      }
    },
  );

for (const kind of ["mysql", "postgresql", "oracle"]) {
  test(
    `${kind} JDBC uses authenticated loopback SOCKS`,
    {
      skip: !process.env.UTERM_DATABASE_PROXY_TEST,
      timeout: 20000,
    },
    async () => {
      const proxy = await authenticatedProxy();
      const child = spawn(
        process.env.UTERM_DATABASE_JAVA || "java",
        [
          "-cp",
          [
            resolve("components/database/engine.jar"),
            resolve(`components/database/target/${kind}.jar`),
          ].join(delimiter),
          "DatabaseBridge",
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      const lines = createInterface({ input: child.stdout });
      try {
        child.stdin.write(
          JSON.stringify({
            id: 1,
            op: "connect",
            config: {
              kind,
              host: "127.0.0.1",
              port: 3306,
              database: "test",
              username: "test",
              tls: false,
            },
            password: "unused",
            proxy_port: proxy.port,
            proxy_token: proxy.token,
          }) + "\n",
        );
        const [line] = await once(lines, "line");
        assert.ok(
          JSON.parse(line).error,
          "The proxy intentionally closes before a database handshake",
        );
        assert.ok(proxy.count() > 0, "The driver must authenticate with the loopback proxy");
      } finally {
        lines.close();
        child.kill();
        proxy.close();
      }
    },
  );
}
