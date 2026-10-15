import test from "node:test";
import assert from "node:assert/strict";
import { databaseChangeCell, databaseDraftRows, databaseExport } from "../src/lib/database-data.ts";

test("grid drafts coalesce, revert, preserve insertion order and handle prototype column names", () => {
  const result = {
    columns: [{ name: "id" }, { name: "__proto__" }],
    rows: [
      ["1", null],
      ["2", "original"],
    ],
  };
  let changes = databaseChangeCell(result, [], 0, 1, "", 1);
  assert.equal(databaseDraftRows(result, changes)[0].cells[1], "");
  changes = databaseChangeCell(result, changes, 0, 1, "updated", 2);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].id, 1);
  assert.deepEqual(databaseChangeCell(result, changes, 0, 1, null, 3), []);
  changes.push(
    { id: 4, kind: "insert", values: { id: "3" } },
    { id: 5, kind: "insert", values: { id: "4" } },
  );
  changes = databaseChangeCell(result, changes, 2, 1, "new", 6);
  assert.deepEqual(
    databaseDraftRows(result, changes).map((row) => row.cells[0]),
    ["1", "2", "3", "4"],
  );
  assert.throws(
    () => databaseChangeCell(result, changes, 0, 1, "x".repeat(16385), 7),
    /DB_INVALID_VALUE/,
  );
});

test("exports retain precision and NULL, quote CSV and neutralize spreadsheet formulas", () => {
  const result = {
    columns: [
      { name: "=header", type: "VARCHAR" },
      { name: "number", type: "DECIMAL" },
    ],
    rows: [
      [null, "12345678901234567890.1234"],
      ["", "-12.5"],
      [' \t=HYPERLINK("bad")', "0"],
      ['a,\n"quoted"', "1"],
    ],
    more: true,
    partial: [[3, 0]],
  };
  assert.deepEqual(JSON.parse(databaseExport(result, "json")), { ...result });
  const csv = databaseExport(result, "csv");
  assert.ok(csv.startsWith('\ufeff"\'=header","number"\r\n"\\N"'));
  assert.ok(csv.includes('"","-12.5"'));
  assert.ok(csv.includes('"\' \t=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"a,\n""quoted"""'));
});
