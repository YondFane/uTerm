import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import {
  databaseError,
  databaseNames,
  type DatabaseKind,
  type DatabaseComponents as ComponentStatus,
} from "../lib/database";

export function DatabaseComponents({ selectedKind }: { selectedKind?: DatabaseKind }) {
  useUiLanguage();
  const [status, setStatus] = useState<ComponentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ id: string; received: number; total: number } | null>(
    null,
  );
  const [remove, setRemove] = useState<string | null>(null);
  async function refresh() {
    try {
      setStatus(
        await invoke<ComponentStatus>("database_components", { action: "status", id: null }),
      );
    } catch (reason) {
      setError(databaseError(reason));
    }
  }
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const track = (promise: Promise<() => void>) =>
      promise
        .then((stop) => {
          if (disposed) stop();
          else stops.push(stop);
        })
        .catch((reason) => {
          if (!disposed) setError(databaseError(reason));
        });
    void Promise.all([
      track(
        listen<{ id: string; received: number; total: number }>(
          "database-component-progress",
          (event) => {
            if (!disposed) setProgress(event.payload);
          },
        ),
      ),
      track(
        listen("database-components-changed", () => {
          if (!disposed) void refresh();
        }),
      ),
    ]).then(() => {
      if (!disposed) void refresh();
    });
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
    };
  }, []);
  const label = (id: string) =>
    id === "runtime" ? tx("Java 运行时") : (databaseNames[id as DatabaseKind] ?? id);
  async function act(action: string, id: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setProgress(null);
    try {
      if (action === "required") {
        let current = await invoke<ComponentStatus>("database_components", {
          action: "status",
          id: null,
        });
        for (const key of ["runtime", id]) {
          if (!current.items.some((item) => item.id === key && item.installed)) {
            current = await invoke<ComponentStatus>("database_components", {
              action: "install",
              id: key,
            });
            setStatus(current);
          }
        }
      } else setStatus(await invoke<ComponentStatus>("database_components", { action, id }));
    } catch (reason) {
      setError(databaseError(reason));
      await refresh();
    } finally {
      setBusy(false);
      setProgress(null);
      setRemove(null);
    }
  }
  const needed =
    status?.items.filter(
      (item) => ["runtime", selectedKind].includes(item.id) && !item.installed,
    ) ?? [];
  const sizeLabel = (bytes: number) =>
    bytes < 1000000 ? `${Math.ceil(bytes / 1000)} KB` : `${(bytes / 1000000).toFixed(1)} MB`;
  return (
    <section className="database-components" aria-label={tx("数据库组件")}>
      <h3>{tx("数据库组件")}</h3>
      <p>
        {tx(
          "连接引擎已内置。只需选择本机 Java 17 或更新版本，或安装 Java 运行时，再按需安装数据库驱动。",
        )}
      </p>
      {status?.java && <p>{tx("Java 路径：{path}", { path: status.java })}</p>}
      {status?.java && <p>{tx("选择本机 Java 不会修改或卸载系统 Java。")}</p>}
      {selectedKind && needed.length > 0 && (
        <button
          type="button"
          disabled={busy || status?.busy}
          onClick={() => void act("required", selectedKind)}
        >
          {tx("安装所需组件（{size}）", {
            size: sizeLabel(needed.reduce((sum, item) => sum + item.size, 0)),
          })}
        </button>
      )}
      <div className="database-component-list">
        {status?.items.map((item) => (
          <div className="database-component-row" key={item.id}>
            <div>
              <strong>{label(item.id)}</strong>
              <small>
                {item.external ? tx("使用本机 Java") : item.version} · {sizeLabel(item.size)}
                {" · "}
                {item.installed ? tx("已安装") : tx("未安装")}
              </small>
              <small title={item.source}>{new URL(item.source).hostname}</small>
            </div>
            <button
              type="button"
              disabled={busy || status.busy}
              onClick={() => void act("install", item.id)}
            >
              {item.installed ? tx("重新安装") : tx("安装")}
            </button>
            <button
              type="button"
              disabled={busy || status.busy}
              onClick={() => void act("import", item.id)}
            >
              {tx("离线安装")}
            </button>
            {item.installed && (
              <button
                type="button"
                disabled={busy || status.busy}
                onClick={() => setRemove(item.id)}
              >
                {tx("卸载")}
              </button>
            )}
          </div>
        ))}
      </div>
      {remove && (
        <div role="alert" className="editor-notice">
          <span>{tx("卸载组件将保留连接配置。已连接时无法卸载。")}</span>
          <button type="button" disabled={busy} onClick={() => void act("remove", remove)}>
            {tx("确认卸载")}
          </button>
          <button type="button" disabled={busy} onClick={() => setRemove(null)}>
            {tx("取消")}
          </button>
        </div>
      )}
      <button
        type="button"
        disabled={busy || status?.busy}
        onClick={() => void act("java", "runtime")}
      >
        {tx("选择本机 Java…")}
      </button>
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        {tx("刷新")}
      </button>
      {(busy || status?.busy) && (
        <p role="status">
          {progress
            ? tx("正在安装 {name}：{percent}%", {
                name: label(progress.id),
                percent: Math.min(100, Math.floor((100 * progress.received) / progress.total)),
              })
            : tx("正在处理组件…")}
          {progress && <progress value={progress.received} max={progress.total} />}
        </p>
      )}
      {(busy || status?.busy) && (
        <button
          type="button"
          onClick={() => {
            void invoke("database_components", { action: "cancel", id: null }).catch((reason) =>
              setError(databaseError(reason)),
            );
          }}
        >
          {tx("取消安装")}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
