import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DatabaseComponents } from "./components/DatabaseComponents";
import { DatabaseConnectionDialog } from "./components/DatabaseConnectionDialog";
import { DatabaseWorkspace } from "./components/DatabaseWorkspace";
import { contentInvoke, listenContent } from "./lib/content-host";
import { contentErrorText } from "./lib/content-transport";
import {
  databaseError,
  databaseConfigFingerprint,
  databaseSnapshot,
  subscribeDatabase,
  type DatabaseConfig,
} from "./lib/database";
import { tx } from "./lib/i18n";
import type { SshConnection } from "./lib/workspace";
import { useSettings } from "./lib/SettingsContext";
import { useUiLanguage } from "./lib/useUiLanguage";

interface Group {
  id: string;
  name: string;
  databaseConnections: DatabaseConfig[];
  sshConnections: SshConnection[];
}
interface Catalog {
  revision: string;
  selectedWorkspace: string;
  groups: Group[];
}
const message = (reason: unknown) =>
  /\bWRITER_BUSY\b/.test(contentErrorText(reason))
    ? tx("配置正在由其他窗口保存，请稍后重试。")
    : /\bCONFLICT\b/.test(contentErrorText(reason))
      ? tx("配置已被其他窗口修改，请重新读取后再保存。")
      : databaseError(reason);

export function NativeDatabase() {
  useUiLanguage();
  const settings = useSettings();
  const reloadSettings = useRef(settings.reload);
  reloadSettings.current = settings.reload;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [groupId, setGroupId] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [tabs, setTabs] = useState<DatabaseConfig[]>([]);
  const [passwords, setPasswords] = useState<
    Record<string, { fingerprint: string; value: string }>
  >({});
  const [dialog, setDialog] = useState<{ group: Group; connection?: DatabaseConfig } | null>(null);
  const [removing, setRemoving] = useState<{ group: Group; connection: DatabaseConfig } | null>(
    null,
  );
  const [components, setComponents] = useState(false);
  const [busy, setBusy] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [error, setError] = useState("");
  const removeDialog = useRef<HTMLDialogElement>(null);
  const revision = useRef(0);
  const statuses = useSyncExternalStore(subscribeDatabase, databaseSnapshot);
  const group = catalog?.groups.find((group) => group.id === groupId);
  const inUse = (id: string) => {
    const state = statuses[id];
    return !!state && (state.connected || state.busy || state.dirty);
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
      const value = await contentInvoke<Catalog>("database_profiles");
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
    track(listenContent<boolean>("database-frozen", (value) => setFrozen(value === true)));
    track(listenContent<string>("database-host-error", (value) => setError(message(value))));
    track(
      listenContent("database-settings-changed", () => {
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
    void contentInvoke("database_guard", {
      id: "native-database-profile-dialog",
      dirty: dialog !== null || removing !== null,
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
  async function save(config: DatabaseConfig, password: string) {
    if (!catalog || !dialog) return false;
    try {
      const value = await contentInvoke<Catalog>("database_profile_save", {
        expectedRevision: catalog.revision,
        workspaceId: dialog.group.id,
        config,
      });
      accept(value);
      setPasswords((previous) => ({
        ...previous,
        [config.id]: { fingerprint: databaseConfigFingerprint(config), value: password },
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
      const removed = await contentInvoke<Catalog>("database_profile_remove", {
        expectedRevision: catalog.revision,
        workspaceId: group.id,
        id: connection.id,
      });
      accept(removed);
      try {
        if (connection.credential_id)
          await contentInvoke("database_credential", {
            config: connection,
            password: null,
            remove: true,
          });
      } catch (reason) {
        const restored = await contentInvoke<Catalog>("database_profile_save", {
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
      className="native-content native-database"
      inert={frozen}
      data-frozen={frozen || undefined}
    >
      <header className="native-database-toolbar">
        <strong>{tx("数据库连接")}</strong>
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
          {tx("添加数据库连接")}
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
        <button onClick={() => setComponents((value) => !value)}>{tx("数据库组件")}</button>
      </header>
      {error && (
        <p className="native-database-error" role="alert">
          {error}
        </p>
      )}
      <div className="native-database-layout">
        <aside aria-label={tx("数据库连接")}>
          {group?.databaseConnections.map((config) => (
            <div
              className="native-database-profile"
              key={config.id}
              data-selected={selected === config.id || undefined}
            >
              <button
                className="native-database-profile-name"
                aria-pressed={selected === config.id && !components}
                onClick={() => {
                  setComponents(false);
                  setSelected(config.id);
                  setTabs((previous) =>
                    previous.some((tab) => tab.id === config.id) ? previous : [...previous, config],
                  );
                }}
              >
                {config.name}
              </button>
              <button
                aria-label={tx("编辑数据库连接：{name}", { name: config.name })}
                disabled={inUse(config.id) || busy}
                onClick={() => setDialog({ group: group!, connection: config })}
              >
                {tx("编辑")}
              </button>
              <button
                aria-label={tx("移除数据库连接：{name}", { name: config.name })}
                disabled={inUse(config.id) || busy}
                onClick={() => setRemoving({ group: group!, connection: config })}
              >
                {tx("移除")}
              </button>
            </div>
          ))}
        </aside>
        <section className="native-database-workbench">
          <div className="native-database-components" hidden={!components}>
            <DatabaseComponents selectedKind={tabs.find((tab) => tab.id === selected)?.kind} />
          </div>
          {!components && !selected && <p>{tx("选择或添加数据库连接后打开工作台。")}</p>}
          {tabs.map((config) => (
            <DatabaseWorkspace
              key={`${config.id}:${databaseConfigFingerprint(config)}`}
              config={config}
              active={selected === config.id && !components}
              password={
                passwords[config.id]?.fingerprint === databaseConfigFingerprint(config)
                  ? passwords[config.id].value
                  : ""
              }
            />
          ))}
        </section>
      </div>
      {dialog && (
        <DatabaseConnectionDialog
          connection={dialog.connection}
          ssh={dialog.group.sshConnections}
          workspaceId={dialog.group.id}
          save={save}
          close={() => setDialog(null)}
          report={setError}
        />
      )}
      <dialog
        ref={removeDialog}
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setRemoving(null);
        }}
      >
        <h3>{tx("移除数据库连接")}</h3>
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
