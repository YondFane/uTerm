import { useState } from "react";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import {
  databaseObjects,
  databaseObjectKey,
  type DatabaseKind,
  type DatabaseObject,
  type DatabaseResult,
} from "../lib/database";

export function DatabaseObjects({
  kind,
  scopes,
  disabled,
  load,
  perform,
  open,
  generate,
  refresh,
}: {
  kind: DatabaseKind;
  scopes: DatabaseResult | null;
  disabled: boolean;
  load: (request: Record<string, unknown>) => Promise<DatabaseResult>;
  perform: (action: () => Promise<void>) => void;
  open: (object: DatabaseObject, view: "data" | "columns") => void;
  generate: (object: DatabaseObject) => void;
  refresh: () => void;
}) {
  useUiLanguage();
  const [filter, setFilter] = useState("");
  const [tables, setTables] = useState<Record<string, DatabaseResult>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [system, setSystem] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState("");
  const names = databaseObjects(scopes ?? {});
  const isSystem = (object: DatabaseObject) =>
    /SYSTEM/i.test(object.type) ||
    /^(information_schema|mysql|performance_schema|sys|pg_catalog|pg_toast|SYS|SYSTEM)$/.test(
      object.name,
    );
  function toggle(scope: DatabaseObject) {
    const key = databaseObjectKey(scope);
    if (expanded[key]) {
      setExpanded((previous) => ({ ...previous, [key]: false }));
      return;
    }
    perform(async () => {
      if (!tables[key]) {
        const result = await load({
          op: "browse",
          view: "tables",
          catalog: kind === "mysql" ? scope.name : "",
          schema: kind === "mysql" ? "" : scope.name,
        });
        setTables((previous) => ({ ...previous, [key]: result }));
      }
      setExpanded((previous) => ({ ...previous, [key]: true }));
    });
  }
  const renderScope = (scope: DatabaseObject) => {
    const key = databaseObjectKey(scope);
    const result = tables[key];
    const objects = databaseObjects(result ?? {});
    const match = (object: DatabaseObject) =>
      object.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase());
    return (
      <div key={key} className="database-object-scope">
        <button
          className="database-tree-scope"
          disabled={disabled}
          aria-expanded={!!expanded[key]}
          onClick={() => toggle(scope)}
          title={scope.name}
        >
          <span aria-hidden="true">{expanded[key] ? "⌄" : "›"}</span>
          <span>{scope.name}</span>
        </button>
        {expanded[key] && (
          <>
            {[
              [
                tx("表"),
                objects.filter((object) => !/VIEW/i.test(object.type) && !isSystem(object)),
              ],
              [
                tx("视图"),
                objects.filter((object) => /VIEW/i.test(object.type) && !isSystem(object)),
              ],
            ].map(([label, entries]) => (
              <div key={String(label)} className="database-tree-group">
                <div className="database-tree-label">{String(label)}</div>
                {(entries as DatabaseObject[]).filter(match).map((object) => (
                  <div
                    className="database-browser-row"
                    key={databaseObjectKey(object)}
                    data-selected={selected === databaseObjectKey(object) || undefined}
                  >
                    <button
                      disabled={disabled}
                      title={object.name}
                      onClick={() => setSelected(databaseObjectKey(object))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          open(object, "data");
                        }
                      }}
                      onDoubleClick={() => open(object, "data")}
                    >
                      {object.name}
                    </button>
                    <details className="database-object-menu">
                      <summary aria-label={tx("对象操作：{name}", { name: object.name })}>
                        ⋯
                      </summary>
                      <div
                        onClick={(event) =>
                          event.currentTarget.parentElement?.removeAttribute("open")
                        }
                      >
                        <button disabled={disabled} onClick={() => open(object, "data")}>
                          {tx("查看数据")}
                        </button>
                        <button disabled={disabled} onClick={() => open(object, "columns")}>
                          {tx("查看结构")}
                        </button>
                        <button disabled={disabled} onClick={() => generate(object)}>
                          {tx("生成 SELECT")}
                        </button>
                      </div>
                    </details>
                  </div>
                ))}
              </div>
            ))}
            {objects.some(isSystem) && (
              <details>
                <summary>{tx("系统对象")}</summary>
                {objects
                  .filter(isSystem)
                  .filter(match)
                  .map((object) => (
                    <button
                      className="database-tree-scope"
                      key={databaseObjectKey(object)}
                      disabled={disabled}
                      onDoubleClick={() => open(object, "data")}
                      onClick={() => setSelected(databaseObjectKey(object))}
                    >
                      {object.name}
                    </button>
                  ))}
              </details>
            )}
            {result?.more && <p>{tx("元数据超过 500 项，请缩小库或模式范围。")}</p>}
            {!objects.length && <p className="database-empty">{tx("没有对象")}</p>}
          </>
        )}
      </div>
    );
  };
  return (
    <>
      <div className="database-object-header">
        <strong>{tx("对象")}</strong>
        <button
          disabled={disabled}
          onClick={() => {
            setTables({});
            setExpanded({});
            refresh();
          }}
        >
          {tx("刷新")}
        </button>
      </div>
      <input
        aria-label={tx("筛选已加载对象")}
        placeholder={tx("筛选已加载对象")}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="database-object-tree" aria-label={tx("数据库对象")}>
        {names.filter((object) => !isSystem(object)).map(renderScope)}
        {names.some(isSystem) && (
          <details
            open={system.root ?? false}
            onToggle={(event) => setSystem({ root: event.currentTarget.open })}
          >
            <summary>{tx("系统对象")}</summary>
            {names.filter(isSystem).map(renderScope)}
          </details>
        )}
        {!names.length && <p className="database-empty">{tx("连接后浏览对象")}</p>}
        {scopes?.more && <p>{tx("元数据超过 500 项，请缩小库或模式范围。")}</p>}
      </div>
    </>
  );
}
