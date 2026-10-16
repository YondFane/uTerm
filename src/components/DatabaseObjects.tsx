import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import {
  databaseObjects,
  databaseObjectKey,
  type DatabaseKind,
  type DatabaseObject,
  type DatabaseResult,
} from "../lib/database";

export const DatabaseObjects = memo(function DatabaseObjects({
  kind,
  scopes,
  disabled,
  load,
  perform,
  open,
  generate,
  refresh,
  loaded,
  visible = true,
}: {
  kind: DatabaseKind;
  scopes: DatabaseResult | null;
  disabled: boolean;
  load: (request: Record<string, unknown>) => Promise<DatabaseResult>;
  perform: (action: () => Promise<void>) => void;
  open: (object: DatabaseObject, view: "data" | "columns") => void;
  generate: (object: DatabaseObject) => void;
  refresh: () => void;
  loaded?: (namespace: string, objects: DatabaseObject[]) => void;
  visible?: boolean;
}) {
  useUiLanguage();
  const [filter, setFilter] = useState("");
  const [tables, setTables] = useState<Record<string, DatabaseResult>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [system, setSystem] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState("");
  const [menu, setMenu] = useState<{
    object: DatabaseObject;
    trigger: HTMLButtonElement;
  } | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  function closeMenu(focus = false) {
    if (focus) menu?.trigger.focus();
    setMenu(null);
  }
  useLayoutEffect(() => {
    if (!menu || !popup.current) return;
    if (!menu.trigger.isConnected || disabled || !visible) {
      closeMenu();
      return;
    }
    const anchor = menu.trigger.getBoundingClientRect();
    const bounds = popup.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8));
    const top = Math.max(
      8,
      Math.min(
        anchor.bottom + bounds.height <= window.innerHeight - 8
          ? anchor.bottom
          : anchor.top - bounds.height,
        window.innerHeight - bounds.height - 8,
      ),
    );
    popup.current.style.left = `${left}px`;
    popup.current.style.top = `${top}px`;
  });
  useEffect(() => {
    if (!menu) return;
    popup.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = (event: PointerEvent | KeyboardEvent) => {
      if ("key" in event && event.key !== "Escape") return;
      if (
        "key" in event ||
        (!popup.current?.contains(event.target as Node) &&
          !menu.trigger.contains(event.target as Node))
      ) {
        if ("key" in event) {
          event.preventDefault();
          event.stopPropagation();
        }
        closeMenu("key" in event);
      }
    };
    const dismissOnMove = (event: Event) => {
      if (event.type !== "scroll" || !popup.current?.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", dismiss, true);
    document.addEventListener("scroll", dismissOnMove, true);
    window.addEventListener("resize", dismissOnMove);
    window.addEventListener("blur", dismissOnMove);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", dismiss, true);
      document.removeEventListener("scroll", dismissOnMove, true);
      window.removeEventListener("resize", dismissOnMove);
      window.removeEventListener("blur", dismissOnMove);
    };
  }, [menu]);
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
        setTables((previous) =>
          Object.fromEntries([...Object.entries(previous).slice(-7), [key, result]]),
        );
        setExpanded((previous) =>
          Object.fromEntries([
            ...Object.entries(previous)
              .filter(([entry]) => entry in tables)
              .slice(-7),
            [key, true],
          ]),
        );
        loaded?.(scope.name, databaseObjects(result));
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
                    <button
                      className="database-object-menu"
                      disabled={disabled}
                      aria-label={tx("对象操作：{name}", { name: object.name })}
                      aria-haspopup="menu"
                      aria-expanded={
                        !!menu && databaseObjectKey(menu.object) === databaseObjectKey(object)
                      }
                      onClick={(event) =>
                        menu?.trigger === event.currentTarget
                          ? closeMenu()
                          : setMenu({ object, trigger: event.currentTarget })
                      }
                    >
                      ⋯
                    </button>
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
      {menu &&
        createPortal(
          <div
            ref={popup}
            className="context-menu database-object-popup"
            role="menu"
            aria-label={tx("对象操作：{name}", { name: menu.object.name })}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
              );
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              buttons[
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                      buttons.length
              ]?.focus();
            }}
          >
            <button
              role="menuitem"
              disabled={disabled}
              onClick={() => {
                closeMenu(true);
                open(menu.object, "data");
              }}
            >
              {tx("查看数据")}
            </button>
            <button
              role="menuitem"
              disabled={disabled}
              onClick={() => {
                closeMenu(true);
                open(menu.object, "columns");
              }}
            >
              {tx("查看结构")}
            </button>
            <button
              role="menuitem"
              disabled={disabled}
              onClick={() => {
                closeMenu(true);
                generate(menu.object);
              }}
            >
              {tx("生成 SELECT")}
            </button>
          </div>,
          document.body,
        )}
    </>
  );
});
