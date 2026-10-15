import { databaseCellText, type DatabaseChange, type DatabaseResult } from "./database.ts";
import { tx } from "./i18n.ts";

export function databaseDraftRows(result: DatabaseResult | null, changes: DatabaseChange[]) {
  const byRow = new Map(
    changes.filter((change) => change.row !== undefined).map((change) => [change.row, change]),
  );
  const names = result?.columns?.map((column) => column.name) ?? [];
  const rows = (result?.rows ?? []).map((row, index) => {
    const change = byRow.get(index);
    return {
      index,
      change,
      cells:
        change?.kind === "update"
          ? row.map((value, at) =>
              Object.hasOwn(change.values, names[at]) ? change.values[names[at]] : value,
            )
          : row,
    };
  });
  for (const change of changes)
    if (change.kind === "insert")
      rows.push({
        index: rows.length,
        change,
        cells: names.map((name) =>
          Object.hasOwn(change.values, name) ? change.values[name] : null,
        ),
      });
  return rows;
}

export function databaseChangeCell(
  result: DatabaseResult,
  changes: DatabaseChange[],
  row: number,
  column: number,
  value: string | null,
  id: number,
): DatabaseChange[] {
  const rows = databaseDraftRows(result, changes);
  const entry = rows[row];
  const name = result.columns?.[column]?.name;
  if (!entry || !name || (value !== null && value.length > 16384))
    throw new Error("DB_INVALID_VALUE");
  const existing = entry.change;
  if (existing?.kind === "delete") throw new Error("DB_INVALID_VALUE");
  const change: DatabaseChange = existing ?? {
    id,
    kind: "update",
    row,
    original: result.rows?.[row],
    values: {},
  };
  const values = { ...change.values, [name]: value };
  if (change.kind === "update" && value === change.original?.[column]) delete values[name];
  const next = { ...change, values };
  if (!Object.keys(values).length && change.kind !== "insert")
    return changes.filter((item) => item.id !== change.id);
  return existing
    ? changes.map((item) => (item.id === change.id ? next : item))
    : [...changes, next];
}

export function databaseExport(result: DatabaseResult, format: "csv" | "json"): string {
  if (format === "json")
    return JSON.stringify(
      {
        columns: result.columns ?? [],
        rows: result.rows ?? [],
        more: result.more ?? false,
        partial: result.partial ?? [],
      },
      null,
      2,
    );
  const quote = (text: string) => '"' + text.replaceAll('"', '""') + '"';
  const rows = (result.rows ?? []).map((row) =>
    row.map((cell, at) => {
      if (cell === null) return "\\N";
      let text = databaseCellText(cell);
      const numeric =
        /^(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|NUMBER)/i.test(
          result.columns?.[at]?.type ?? "",
        ) && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text);
      if (!numeric && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = "'" + text;
      return text;
    }),
  );
  rows.unshift(
    (result.columns ?? []).map((column) =>
      /^[\s\u0000-\u001f]*[=+\-@]/.test(column.name) ? "'" + column.name : column.name,
    ),
  );
  return "\ufeff" + rows.map((row) => row.map(quote).join(",")).join("\r\n");
}

export function databasePreview(result: DatabaseResult): string {
  return (result.preview ?? [])
    .map(
      (entry) =>
        `${entry.sql};\n-- ${tx("参数：{values}", { values: JSON.stringify(entry.parameters) })}`,
    )
    .join("\n\n");
}
