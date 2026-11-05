import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RedisConnectionDialog } from "./components/RedisConnectionDialog";
import { RedisWorkspace } from "./components/RedisWorkspace";
import { contentInvoke, listenContent } from "./lib/content-host";
import { contentErrorText } from "./lib/content-transport";
import {
  redisError,
  redisConfigFingerprint,
  redisSnapshot,
  subscribeRedis,
  type RedisConfig,
} from "./lib/redis";
import { tx } from "./lib/i18n";
import type { SshConnection } from "./lib/workspace";
import { useSettings } from "./lib/SettingsContext";
import { useUiLanguage } from "./lib/useUiLanguage";
import { randomUUID } from "./lib/uuid";

interface Group {
  id: string;
  name: string;
  redisConnections: RedisConfig[];
  sshConnections: SshConnection[];
}
interface Catalog {
  revision: string;
  selectedWorkspace: string;
  groups: Group[];
}
const message = (reason: unknown) =>
  /\bCONFLICT\b/.test(contentErrorText(reason))
    ? tx("配置已被其他窗口修改，请重新读取后再保存。")
    : redisError(reason);

export function NativeRedis() {
  useUiLanguage();
  const settings = useSettings();
  const reloadSettings = useRef(settings.reload);
  reloadSettings.current = settings.reload;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [groupId, setGroupId] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [tabs, setTabs] = useState<RedisConfig[]>([]);
  const [passwords, setPasswords] = useState<
    Record<string, { fingerprint: string; value: string }>
  >({});
  const [dialog, setDialog] = useState<{ group: Group; connection?: RedisConfig } | null>(null);
  const [removing, setRemoving] = useState<{ group: Group; connection: RedisConfig } | null>(null);
  const [busy, setBusy] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [error, setError] = useState("");
  const removeDialog = useRef<HTMLDialogElement>(null);
  const revision = useRef(0);
  const profileGuard = useRef(randomUUID());
  const statuses = useSyncExternalStore(subscribeRedis, redisSnapshot);
  const group = catalog?.groups.find((group) => group.id === groupId);
  const inUse = (id: string) => {
    const state = statuses[id];
    return !!state && (state.connected || state.opening || state.dirty);
  };
  const accept = (value: Catalog) => {
    revision.current++;
    setCatalog(value);
    setGroupId((previous) =>
      value.groups.some((group) => group.id === previous) ? previous : value.selectedWorkspace,
    );
  };
  async function refresh() {
    const generation = ++revision.current;
    try {
      const value = await contentInvoke<Catalog>("redis_profiles");
      if (revision.current === generation) accept(value);
    } catch (reason) {
      if (revision.current === generation) setError(message(reason));
    }
  }
  useEffect(() => {
    let active = true;
    const stops: (() => void)[] = [];
    const track = (promise: Promise<() => void>) =>
      void promise
        .then((stop) => {
          if (active) stops.push(stop);
          else stop();
        })
        .catch((reason) => {
          if (active) setError(message(reason));
        });
    track(listenContent<boolean>("redis-frozen", (value) => setFrozen(value === true)));
    track(listenContent<string>("redis-host-error", (value) => setError(message(value))));
    track(
      listenContent("redis-settings-changed", () => {
        void reloadSettings.current().catch((reason) => setError(message(reason)));
      }),
    );
    void refresh();
    return () => {
      active = false;
      revision.current++;
      stops.forEach((stop) => stop());
    };
  }, []);
  useEffect(() => {
    void contentInvoke("redis_guard", {
      id: profileGuard.current,
      active: dialog !== null || removing !== null,
    }).catch((reason) => setError(message(reason)));
  }, [dialog, removing]);
  useEffect(() => {
    if (removing) removeDialog.current?.showModal();
    else removeDialog.current?.close();
  }, [removing]);
  useEffect(() => {
    if (!frozen) return;
    // Modal dialogs escape an inert ancestor, so freeze each open dialog as well.
    // 模态对话框不继承祖先的 inert，因此也要逐个冻结已打开的对话框。
    const dialogs = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].map(
      (dialog) => ({ dialog, inert: dialog.inert }),
    );
    dialogs.forEach(({ dialog }) => {
      dialog.inert = true;
    });
    return () =>
      dialogs.forEach(({ dialog, inert }) => {
        dialog.inert = inert;
      });
  }, [frozen]);
  async function save(config: RedisConfig, password: string) {
    if (!catalog || !dialog) return false;
    try {
      const value = await contentInvoke<Catalog>("redis_profile_save", {
        expectedRevision: catalog.revision,
        workspaceId: dialog.group.id,
        config,
      });
      accept(value);
      setPasswords((previous) => ({
        ...previous,
        [config.id]: { fingerprint: redisConfigFingerprint(config), value: password },
      }));
      setTabs((previous) => previous.map((tab) => (tab.id === config.id ? config : tab)));
      setError("");
      return true;
    } catch (reason) {
      setError(message(reason));
      return false;
    }
  }
  async function remove() {
    if (!catalog || !removing || busy) return;
    const { group, connection } = removing;
    setBusy(true);
    setError("");
    try {
      const removed = await contentInvoke<Catalog>("redis_profile_remove", {
        expectedRevision: catalog.revision,
        workspaceId: group.id,
        id: connection.id,
      });
      accept(removed);
      try {
        if (connection.credential_id)
          await contentInvoke("redis_credential", {
            config: connection,
            password: null,
            remove: true,
          });
      } catch (reason) {
        const restored = await contentInvoke<Catalog>("redis_profile_save", {
          expectedRevision: removed.revision,
          workspaceId: group.id,
          config: connection,
        });
        accept(restored);
        throw reason;
      }
      setTabs((previous) => previous.filter((tab) => tab.id !== connection.id));
      setPasswords((previous) => {
        const next = { ...previous };
        delete next[connection.id];
        return next;
      });
      setSelected((previous) => (previous === connection.id ? null : previous));
      setRemoving(null);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main
      className="native-content native-database native-redis"
      inert={frozen}
      data-frozen={frozen || undefined}
    >
      <header className="native-database-toolbar">
        <strong>{tx("Redis 连接")}</strong>
        <select
          aria-label={tx("工作区")}
          value={groupId}
          disabled={busy}
          onChange={(event) => setGroupId(event.target.value)}
        >
          {catalog?.groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        <button disabled={!group || busy} onClick={() => setDialog({ group: group! })}>
          {tx("添加 Redis 连接")}
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setError("");
            void refresh();
          }}
        >
          {tx("重新读取")}
        </button>
      </header>
      {error && (
        <p className="native-database-error" role="alert">
          {error}
        </p>
      )}
      <div className="native-database-layout">
        <aside aria-label={tx("Redis 连接")}>
          {group?.redisConnections.map((config) => (
            <div
              className="native-database-profile"
              key={config.id}
              data-selected={selected === config.id || undefined}
            >
              <button
                className="native-database-profile-name"
                aria-pressed={selected === config.id}
                onClick={() => {
                  setSelected(config.id);
                  setTabs((previous) =>
                    previous.some((tab) => tab.id === config.id) ? previous : [...previous, config],
                  );
                }}
              >
                {config.name}
              </button>
              <button
                aria-label={tx("编辑 Redis 连接：{name}", { name: config.name })}
                disabled={inUse(config.id) || busy}
                onClick={() => setDialog({ group: group!, connection: config })}
              >
                {tx("编辑")}
              </button>
              <button
                aria-label={tx("移除 Redis 连接：{name}", { name: config.name })}
                disabled={inUse(config.id) || busy}
                onClick={() => setRemoving({ group: group!, connection: config })}
              >
                {tx("移除")}
              </button>
            </div>
          ))}
        </aside>
        <section className="native-database-workbench">
          {!selected && <p>{tx("选择或添加 Redis 连接后打开工作台。")}</p>}
          {tabs.map((config) => (
            <RedisWorkspace
              key={`${config.id}:${redisConfigFingerprint(config)}`}
              config={config}
              active={selected === config.id}
              consumed={() =>
                setPasswords((previous) => {
                  const next = { ...previous };
                  delete next[config.id];
                  return next;
                })
              }
              password={
                passwords[config.id]?.fingerprint === redisConfigFingerprint(config)
                  ? passwords[config.id].value
                  : ""
              }
            />
          ))}
        </section>
      </div>
      {dialog && (
        <RedisConnectionDialog
          connection={dialog.connection}
          ssh={dialog.group.sshConnections}
          workspaceId={dialog.group.id}
          save={save}
          close={() => setDialog(null)}
        />
      )}
      <dialog
        ref={removeDialog}
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setRemoving(null);
        }}
      >
        <h3>{tx("移除 Redis 连接")}</h3>
        <p>
          {tx("确定移除连接“{name}”？此操作会删除保存的连接配置及其已记住的密码。", {
            name: removing?.connection.name ?? "",
          })}
        </p>
        <div className="dialog-actions">
          <button disabled={busy} onClick={() => setRemoving(null)}>
            {tx("取消")}
          </button>
          <button disabled={busy} onClick={() => void remove()}>
            {tx("确认移除")}
          </button>
        </div>
      </dialog>
    </main>
  );
}
