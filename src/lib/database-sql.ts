import type { DatabaseKind } from "./database";

export interface SqlToken {
  from: number;
  to: number;
  text: string;
  kind: "word" | "quoted" | "comment" | "symbol";
}
export interface SqlStatement {
  from: number;
  to: number;
  sql: string;
  readonly: boolean;
}

export function sqlTokens(text: string, kind: DatabaseKind): SqlToken[] {
  if (text.length > 262144) throw new Error("DB_INPUT_LIMIT");
  const tokens: SqlToken[] = [];
  let at = 0;
  const fail = () => {
    throw new Error("DB_SQL_UNSUPPORTED");
  };
  while (at < text.length) {
    if (/\s/.test(text[at])) {
      at++;
      continue;
    }
    const from = at;
    let type: SqlToken["kind"] = "symbol";
    if (
      (text.startsWith("--", at) && (kind !== "mysql" || /\s/.test(text[at + 2] ?? " "))) ||
      (kind === "mysql" && text[at] === "#")
    ) {
      type = "comment";
      at = text.indexOf("\n", at);
      if (at < 0) at = text.length;
    } else if (text.startsWith("/*", at)) {
      if (text[at + 2] === "!") fail();
      type = "comment";
      at += 2;
      let depth = 1;
      while (at < text.length && depth) {
        if (kind === "postgresql" && text.startsWith("/*", at)) {
          depth++;
          at += 2;
        } else if (text.startsWith("*/", at)) {
          depth--;
          at += 2;
        } else at++;
        if (depth > 256) fail();
      }
      if (depth) fail();
    } else {
      const dollar =
        kind === "postgresql" && text[at] === "$"
          ? /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(text.slice(at))?.[0]
          : undefined;
      if (dollar) {
        type = "quoted";
        const end = text.indexOf(dollar, at + dollar.length);
        if (end < 0) fail();
        at = end + dollar.length;
      } else if (kind === "oracle" && /^[qQ]'/.test(text.slice(at, at + 2))) {
        type = "quoted";
        const delimiter = text[at + 2];
        const close =
          ({ "[": "]", "(": ")", "{": "}", "<": ">" } as Record<string, string>)[delimiter] ??
          delimiter;
        if (!delimiter || /\s/.test(delimiter)) fail();
        const end = text.indexOf(close + "'", at + 3);
        if (end < 0) fail();
        at = end + 2;
      } else if (["'", '"', "`"].includes(text[at])) {
        type = "quoted";
        const quote = text[at++];
        let closed = false;
        while (at < text.length) {
          if (
            text[at] === "\\" &&
            (kind === "mysql" || (kind === "postgresql" && /^[eE]$/.test(text[from - 1] ?? "")))
          ) {
            at += 2;
          } else if (text[at++] === quote) {
            if (text[at] === quote) at++;
            else {
              closed = true;
              break;
            }
          }
        }
        if (!closed) fail();
      } else if (/\d/.test(text[at]) || (text[at] === "." && /\d/.test(text[at + 1] ?? ""))) {
        type = "quoted";
        const numeric = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(at));
        at += numeric![0].length;
      } else if (/[\p{L}\p{N}_$]/u.test(String.fromCodePoint(text.codePointAt(at)!))) {
        type = "word";
        while (
          at < text.length &&
          /[\p{L}\p{N}_$]/u.test(String.fromCodePoint(text.codePointAt(at)!))
        )
          at += text.codePointAt(at)! > 65535 ? 2 : 1;
      } else at++;
    }
    tokens.push({ from, to: at, text: text.slice(from, at), kind: type });
    if (tokens.length > 65536) fail();
  }
  return tokens;
}

const unsafe = new Set(
  "INSERT UPDATE DELETE MERGE REPLACE UPSERT INTO CREATE ALTER DROP TRUNCATE GRANT REVOKE CALL EXEC EXECUTE COPY LOAD LOCK UNLOCK SET RESET VACUUM ANALYZE COMMIT ROLLBACK SAVEPOINT RELEASE DO HANDLER OUTFILE DUMPFILE".split(
    " ",
  ),
);
export function sqlStatements(text: string, kind: DatabaseKind): SqlStatement[] {
  const tokens = sqlTokens(text, kind);
  const statements: SqlStatement[] = [];
  let start = 0;
  let depth = 0;
  let current: SqlToken[] = [];
  const finish = (to: number) => {
    const significant = current.filter((token) => token.kind !== "comment");
    if (significant.length) {
      const words = significant
        .filter((token) => token.kind === "word")
        .map((token) => token.text.toUpperCase());
      if (
        words[0] === "DELIMITER" ||
        (kind === "oracle" && ["DECLARE", "BEGIN"].includes(words[0]) && words.length > 1) ||
        (kind === "oracle" &&
          words[0] === "CREATE" &&
          words.some((word) => ["PROCEDURE", "FUNCTION", "TRIGGER", "PACKAGE"].includes(word)))
      )
        throw new Error("DB_SQL_UNSUPPORTED");
      const readonly =
        ["SELECT", "WITH"].includes(words[0]) &&
        !words.some((word) => unsafe.has(word)) &&
        !words.includes("FOR") &&
        !significant.some(
          (token, index) =>
            (token.text === ":" && significant[index + 1]?.text === "=") ||
            (kind === "mysql" && token.kind === "quoted" && /\\['"]/.test(token.text)),
        );
      const from = start + text.slice(start, to).search(/\S/);
      statements.push({ from, to, sql: text.slice(from, to).trimEnd(), readonly });
    }
    start = to + 1;
    current = [];
  };
  for (const token of tokens) {
    if (token.kind === "symbol") {
      if (token.text === "(") depth++;
      if (token.text === ")") depth--;
      if (depth < 0 || depth > 256) throw new Error("DB_SQL_UNSUPPORTED");
      if (token.text === ";" && depth === 0) {
        finish(token.from);
        continue;
      }
    }
    current.push(token);
  }
  if (depth) throw new Error("DB_SQL_UNSUPPORTED");
  finish(text.length);
  if (statements.length > 100) throw new Error("DB_INPUT_LIMIT");
  return statements;
}

export function sqlExecution(
  text: string,
  kind: DatabaseKind,
  scope: "current" | "selection" | "all",
  from: number,
  to = from,
): SqlStatement[] {
  if (scope === "selection")
    return sqlStatements(text.slice(from, to), kind).map((statement) => ({
      ...statement,
      from: statement.from + from,
      to: statement.to + from,
    }));
  const statements = sqlStatements(text, kind);
  if (scope === "all") return statements;
  return [
    statements.find((statement) => from >= statement.from && from <= statement.to) ??
      statements.find((statement) => statement.from >= from) ??
      statements.at(-1),
  ].filter((statement): statement is SqlStatement => !!statement);
}

export function formatDatabaseSql(text: string, kind: DatabaseKind): string {
  const tokens = sqlTokens(text, kind);
  let output = "";
  let depth = 0;
  let previous: SqlToken | undefined;
  for (const token of tokens) {
    const upper = token.kind === "word" ? token.text.toUpperCase() : token.text;
    const clause =
      depth === 0 &&
      /^(SELECT|FROM|WHERE|GROUP|ORDER|HAVING|LIMIT|OFFSET|JOIN|LEFT|RIGHT|INNER|OUTER|UNION|VALUES|SET|RETURNING)$/.test(
        upper,
      );
    const line =
      (previous?.kind === "comment" && !previous.text.startsWith("/*")) ||
      previous?.text === ";" ||
      clause ||
      (depth === 0 && previous?.text === ",");
    const adjacent =
      previous &&
      previous.to === token.from &&
      !(previous.text === "-" && token.text === "-") &&
      ![",", ";"].includes(previous.text);
    const gap =
      !output || adjacent || [",", ";", ")", "."].includes(token.text) || previous?.text === "("
        ? ""
        : line
          ? "\n"
          : " ";
    output += gap + token.text;
    if (token.text === "(") depth++;
    if (token.text === ")") depth--;
    previous = token;
  }
  return output.trim();
}
