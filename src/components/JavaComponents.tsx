import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { javaError, javaSize, type JavaComponentsStatus } from "../lib/java-build";
import { displayLocalPath } from "../lib/file-target";
import type { JavaConfiguration } from "../lib/java-build";

type ComponentAction = "install" | "import" | "cancel";

export function JavaComponents({ changed }: { changed?: () => void }) {
  useUiLanguage();
  const [componentStatus, setComponentStatus] = useState<JavaComponentsStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [progress, setProgress] = useState<{ id: string; received: number; total: number } | null>(
    null,
  );
  const mounted = useRef(true);
  const statusRequestVersion = useRef(0);
  const jdkRequestVersion = useRef(0);
  const [localJdks, setLocalJdks] = useState<JavaConfiguration["jdks"] | null>(null);
  const [jdkError, setJdkError] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [jdkHome, setJdkHome] = useState("");
  const [jdkBusy, setJdkBusy] = useState(false);
  const jdkActionPending = useRef(false);
  async function refreshJdks() {
    if (jdkActionPending.current) return;
    const request = ++jdkRequestVersion.current;
    setDetecting(true);
    try {
      const jdks = await invoke<JavaConfiguration["jdks"]>("java_detect_jdks");
      if (mounted.current && request === jdkRequestVersion.current) {
        setLocalJdks(jdks);
        setJdkError("");
      }
    } catch (reason) {
      if (mounted.current && request === jdkRequestVersion.current) setJdkError(javaError(reason));
    } finally {
      if (mounted.current && request === jdkRequestVersion.current) setDetecting(false);
    }
  }
  async function updateJdk(home: string, remove = false) {
    if (jdkActionPending.current) return;
    jdkActionPending.current = true;
    jdkRequestVersion.current++;
    setJdkBusy(true);
    setDetecting(false);
    setJdkError("");
    try {
      const jdks = await invoke<JavaConfiguration["jdks"]>("java_register_jdk", { home, remove });
      if (mounted.current) {
        setLocalJdks(jdks);
        if (!remove) {
          setAdding(false);
          setJdkHome("");
        }
        onComponentsChanged.current?.();
      }
    } catch (reason) {
      if (mounted.current) setJdkError(javaError(reason));
    } finally {
      jdkActionPending.current = false;
      if (mounted.current) setJdkBusy(false);
    }
  }
  async function chooseJdkHome() {
    if (jdkActionPending.current) return;
    jdkActionPending.current = true;
    setJdkBusy(true);
    try {
      const home = await invoke<string | null>("java_select_path", {
        kind: "home",
        directory: jdkHome,
      });
      if (mounted.current && home) setJdkHome(displayLocalPath(home));
    } catch (reason) {
      if (mounted.current) setJdkError(javaError(reason));
    } finally {
      jdkActionPending.current = false;
      if (mounted.current) setJdkBusy(false);
    }
  }
  // Cancellation can finish before installation; keep controls busy until both replies settle.
  // 取消请求可能比安装先完成，需要等待两个响应都结束后再解除控件忙态。
  const pendingOperations = useRef(0);
  const onComponentsChanged = useRef(changed);
  onComponentsChanged.current = changed;
  async function refreshStatus(clearError = false) {
    const request = ++statusRequestVersion.current;
    if (clearError) setError("");
    try {
      const next = await invoke<JavaComponentsStatus>("java_components", {
        action: "status",
        id: null,
      });
      if (mounted.current && request === statusRequestVersion.current) setComponentStatus(next);
    } catch (reason) {
      if (mounted.current && request === statusRequestVersion.current) setError(javaError(reason));
    }
  }
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const stops: (() => void)[] = [];
    void refreshStatus();
    void refreshJdks();
    for (const promise of [
      listen<{ id: string; received: number; total: number }>(
        "java-component-progress",
        (event) => {
          if (!disposed) setProgress(event.payload);
        },
      ),
      listen("java-components-changed", () => {
        if (!disposed) {
          void refreshStatus();
          if (!pendingOperations.current) void refreshJdks();
          onComponentsChanged.current?.();
        }
      }),
    ])
      void promise
        .then((stop) => (disposed ? stop() : stops.push(stop)))
        .catch((reason) => {
          if (!disposed) setError(javaError(reason));
        });
    return () => {
      disposed = true;
      mounted.current = false;
      statusRequestVersion.current++;
      jdkRequestVersion.current++;
      stops.forEach((stop) => stop());
    };
  }, []);
  async function runComponentAction(action: ComponentAction, id?: string) {
    if (action !== "cancel" && pendingOperations.current) return;
    pendingOperations.current++;
    statusRequestVersion.current++;
    setBusy(true);
    setError("");
    if (action !== "cancel") setProgress(null);
    try {
      await invoke<JavaComponentsStatus>("java_components", { action, id: id ?? null });
      if (mounted.current && action !== "cancel") onComponentsChanged.current?.();
    } catch (reason) {
      if (mounted.current) setError(javaError(reason));
    } finally {
      pendingOperations.current--;
      if (mounted.current) {
        setBusy(pendingOperations.current > 0);
        // An action reply may already be stale after another action; read a versioned snapshot.
        // 另一操作可能已使当前响应过期，因此重新读取带请求版本校验的状态快照。
        void refreshStatus();
        if (action !== "cancel") void refreshJdks();
      }
    }
  }
  const installationPending = busy || componentStatus?.busy === true;
  return (
    <section className="java-components" aria-label={tx("Java 开发环境")}>
      <p className="java-help">
        {tx(
          "优先使用本机 JDK，仅按需安装选择的版本。Maven 编译需要完整 JDK，数据库 JRE 不能代替。",
        )}
      </p>
      <p className="java-help">
        {tx("安装前显示下载体积；下载中断可继续，也可手动下载后离线安装。")}
      </p>
      <div className="java-form-actions">
        <button
          type="button"
          disabled={busy || detecting || jdkBusy}
          onClick={() => {
            void refreshStatus(true);
            void refreshJdks();
          }}
        >
          {tx("检测本机 JDK")}
        </button>
        <button type="button" disabled={jdkBusy} onClick={() => setAdding(true)}>
          {tx("手动添加 JDK")}
        </button>
        {installationPending && (
          <button type="button" onClick={() => void runComponentAction("cancel")}>
            {tx("取消安装")}
          </button>
        )}
      </div>
      {adding && (
        <form
          className="java-add-jdk"
          onSubmit={(event) => {
            event.preventDefault();
            void updateJdk(jdkHome.trim());
          }}
        >
          <label>
            {tx("JDK 主目录")}
            <div className="java-path-input">
              <input
                autoFocus
                value={jdkHome}
                disabled={jdkBusy}
                onChange={(event) => setJdkHome(event.target.value)}
              />
              <button type="button" disabled={jdkBusy} onClick={() => void chooseJdkHome()}>
                {tx("选择 JDK 主目录")}
              </button>
            </div>
          </label>
          <p className="java-help">
            {tx("选择包含 bin/java 和 bin/javac 的 JDK 8、11、17 或 21 目录。")}
          </p>
          <div className="java-form-actions">
            <button type="submit" disabled={jdkBusy || !jdkHome.trim()}>
              {tx("添加")}
            </button>
            <button type="button" disabled={jdkBusy} onClick={() => setAdding(false)}>
              {tx("取消")}
            </button>
          </div>
        </form>
      )}
      <section className="java-detected-jdks" aria-label={tx("检测到的 JDK")}>
        <h3>{tx("检测到的 JDK")}</h3>
        {localJdks === null && !jdkError && <p className="java-help">{tx("正在读取…")}</p>}
        {localJdks?.length === 0 && (
          <p className="java-help">{tx("未检测到本机 JDK。可选择本机路径或安装所需版本。")}</p>
        )}
        {localJdks?.map((jdk) => (
          <div className="java-component-row" key={jdk.home}>
            <div>
              <strong>{`JDK ${jdk.version}`}</strong>
              <small>
                {jdk.registered ? tx("手动添加") : tx("自动检测")}
                {jdk.available === false ? ` · ${tx("当前不可用")}` : ""}
              </small>
              <span className="java-local-path" title={displayLocalPath(jdk.home)}>
                {displayLocalPath(jdk.home)}
              </span>
            </div>
            {jdk.registered && (
              <button
                type="button"
                disabled={jdkBusy || detecting}
                title={tx("仅移除记录，不删除 JDK 文件。")}
                onClick={() => void updateJdk(jdk.home, true)}
              >
                {tx("移除记录")}
              </button>
            )}
          </div>
        ))}
        {jdkError && (
          <p role="alert" className="java-error">
            {jdkError}
          </p>
        )}
      </section>
      <h3>{tx("可选托管工具")}</h3>
      {componentStatus?.items.map((item) => (
        <div className="java-component-row" key={item.id}>
          <div>
            <strong>
              {item.id === "maven" ? tx("托管 Maven") : item.id.replace("jdk-", "JDK ")}
            </strong>
            <small>
              {item.version} · {javaSize(item.size)} ·{" "}
              {item.installed ? tx("已安装") : tx("未安装")}
            </small>
            <small>{new URL(item.source).hostname}</small>
            {!item.installed && item.downloaded > 0 && (
              <small>{tx("已下载 {size}", { size: javaSize(item.downloaded) })}</small>
            )}
          </div>
          <div className="java-component-actions">
            <button
              type="button"
              disabled={installationPending || item.installed}
              onClick={() => void runComponentAction("install", item.id)}
            >
              {item.installed ? tx("已就绪") : item.downloaded ? tx("继续下载") : tx("安装")}
            </button>
            <button
              type="button"
              disabled={installationPending}
              onClick={() => void runComponentAction("import", item.id)}
            >
              {tx("离线安装")}
            </button>
            <button
              type="button"
              onClick={() =>
                void invoke("open_external", { url: item.source }).catch((reason) =>
                  setError(javaError(reason)),
                )
              }
            >
              {tx("手动下载")}
            </button>
          </div>
        </div>
      ))}
      {progress && installationPending && (
        <div className="java-progress" role="status">
          <span>
            {progress.id} · {javaSize(progress.received)} / {javaSize(progress.total)}
          </span>
          <progress value={progress.received} max={progress.total} />
        </div>
      )}
      {error && (
        <p role="alert" className="java-error">
          {error}
        </p>
      )}
    </section>
  );
}
