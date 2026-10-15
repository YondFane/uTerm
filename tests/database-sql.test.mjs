import test from "node:test";
import assert from "node:assert/strict";
import {
  sqlTokens,
  sqlStatements,
  sqlExecution,
  formatDatabaseSql,
} from "../src/lib/database-sql.ts";

test("SQL execution respects dialect strings, comments and statement boundaries", () => {
  for (const [kind, sql, count] of [
    ["mysql", "-- SELECT;\nSELECT ';', `a;b` FROM t WHERE id=1; #ignored;\nSELECT 2", 2],
    ["mysql", "SELECT 'it\\'s; fine'; SELECT 2", 2],
    ["postgresql", "SELECT $tag$not; a 'statement'$tag$; /* outer /* inner; */ end */ SELECT 2", 2],
    ["postgresql", "SELECT E'it\\'s; fine', 'doubled''quote;'; SELECT 2", 2],
    ["oracle", "SELECT q'[can't; split]' FROM dual; SELECT q'!x;y!' FROM dual", 2],
  ])
    assert.equal(sqlStatements(sql, kind).length, count);
  const sql = "SELECT 1;\nSELECT 'second; value';\nSELECT 3";
  assert.equal(sqlExecution(sql, "mysql", "current", 14)[0].sql, "SELECT 'second; value'");
  assert.equal(sqlExecution(sql, "mysql", "selection", 10, 32)[0].from, 10);
  assert.equal(sqlExecution(sql, "mysql", "all", 0).length, 3);
  assert.throws(() => sqlStatements("SELECT 'unfinished", "mysql"), /DB_SQL_UNSUPPORTED/);
  assert.throws(() => sqlStatements("SELECT /*unfinished", "postgresql"), /DB_SQL_UNSUPPORTED/);
  assert.throws(() => sqlStatements("SELECT $$unfinished", "postgresql"), /DB_SQL_UNSUPPORTED/);
  assert.throws(() => sqlStatements("BEGIN SELECT 1; END;", "oracle"), /DB_SQL_UNSUPPORTED/);
  assert.throws(() => sqlStatements("SELECT 1;".repeat(101), "mysql"), /DB_INPUT_LIMIT/);
});

test("read-only SQL classification accepts comments and safe CTEs and rejects writing CTEs and assignments", () => {
  for (const kind of ["mysql", "postgresql", "oracle"]) {
    for (const text of [
      "/* query */ SELECT * FROM t WHERE id=1",
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "SELECT 'UPDATE x', \"delete\" FROM t",
      "SELECT 1::int",
    ])
      assert.equal(sqlStatements(text, kind)[0].readonly, true, text);
    for (const text of [
      "WITH x AS (DELETE FROM t RETURNING id) SELECT * FROM x",
      "SELECT * INTO target FROM source",
      "SELECT * FROM t FOR UPDATE",
      "SELECT @x := 1",
      "UPDATE t SET x=1",
    ])
      assert.equal(sqlStatements(text, kind)[0].readonly, false, text);
    assert.throws(
      () => sqlStatements("SELECT 1 /*!; DELETE FROM t */", kind),
      /DB_SQL_UNSUPPORTED/,
    );
  }
});

test("formatting retains SQL literal/comment contents and compound operators", () => {
  for (const kind of ["mysql", "postgresql", "oracle"]) {
    const original =
      "select name, 'a; b\nkeep whitespace' from t -- keep this comment\nwhere id>=1 and id!=2 and code::text='a' order by name";
    const formatted = formatDatabaseSql(original, kind);
    const signature = (text) =>
      sqlTokens(text, kind).map((token) =>
        token.kind === "word" ? token.text.toUpperCase() : token.text,
      );
    assert.deepEqual(signature(formatted), signature(original));
    assert.ok(formatted.includes(">="));
    assert.ok(formatted.includes("!="));
    assert.ok(formatted.includes("::"));
    assert.match(formatted, /\nfrom/i);
    assert.ok(formatted.includes("-- keep this comment\n"));
  }
  const mysql = "select count(*), 1e-3, 0xFF, 1--2 from First where offset>=.1";
  const formatted = formatDatabaseSql(mysql, "mysql");
  assert.match(formatted, /count\(\*\)/);
  assert.ok(formatted.includes("1e-3"));
  assert.ok(formatted.includes("First"));
  assert.ok(formatted.includes("offset"));
  assert.equal(
    sqlTokens(formatted, "mysql").some((token) => token.kind === "comment"),
    false,
  );
  assert.deepEqual(
    sqlTokens(formatted, "mysql").map((token) => token.text),
    sqlTokens(mysql, "mysql").map((token) => token.text),
  );
  assert.equal(sqlStatements("SELECT $中文$'; literal $中文$; SELECT 2", "postgresql").length, 2);
  for (const [kind, text, fragments] of [
    [
      "postgresql",
      `SELECT U&'d\\0061t', U&"name", $1::int FROM t`,
      ["U&'d\\0061t'", 'U&"name"', "$1::int"],
    ],
    ["mysql", "SELECT @value, @@version, t.* FROM t", ["@value", "@@version", "t.*"]],
    [
      "oracle",
      "SELECT N'中文', value FROM test@remote WHERE id=:id",
      ["N'中文'", "test@remote", ":id"],
    ],
  ])
    for (const fragment of fragments) assert.ok(formatDatabaseSql(text, kind).includes(fragment));
});
