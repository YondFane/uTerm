import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { localizeMessage, tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { SidebarIcon } from "./SidebarIcon";

type Branches = { current: string | null; local: string[] };

export function BranchSelector({
  directory,
  disabled,
  beforeSwitch,
  onChanged,
  onError,
}: {
  directory: string;
  disabled: boolean;
  beforeSwitch: (action: () => Promise<void>) => void;
  onChanged: () => void;
  onError: (error: string) => void;
}) {
  useUiLanguage();
  const [branches, setBranches] = useState<Branches | null>(null);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(false);
  const alive = useRef(false);
  const changing = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let loading = false;
    async function refresh() {
      if (loading || changing.current || document.hidden) return;
      loading = true;
      const request = revision.current;
      try {
        const next = await invoke<Branches>("git_branches", { directory });
        if (!disposed && request === revision.current) {
          // Keep unchanged polling results from rerendering the control or replacing an open list.
          // 轮询结果不变时保留状态，避免重绘控件或替换已打开的列表。
          setBranches((previous) =>
            JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
          );
          setError("");
        }
      } catch (reason) {
        if (!disposed && request === revision.current) setError(String(reason));
      } finally {
        loading = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive.current = false;
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [directory]);

  function select(branch: string) {
    const expected = branches?.current;
    if (disabled || changing.current || !expected || branch === expected) return;
    beforeSwitch(async () => {
      // A deferred editor save must not switch the repository after its selector was unmounted.
      // 编辑器延迟保存完成后，不能再切换已卸载选择器对应的仓库。
      if (!alive.current || changing.current) return;
      changing.current = true;
      revision.current += 1;
      setSwitching(true);
      try {
        await invoke<void>("git_switch_branch", { directory, branch, expected });
        if (!alive.current) return;
        setBranches((previous) => previous && { ...previous, current: branch });
        setError("");
        onChanged();
      } catch (reason) {
        if (alive.current) onError(String(reason));
      } finally {
        changing.current = false;
        if (alive.current) setSwitching(false);
      }
    });
  }

  if (!branches?.current && !error) return null;
  const current = branches?.current ?? "";
  return (
    <label
      className="workspace-branch"
      title={error ? localizeMessage(error) : tx("当前分支：{p0}", { p0: current })}
    >
      <SidebarIcon name="branch" />
      <select
        aria-label={tx("切换分支")}
        aria-busy={switching}
        disabled={disabled || switching || !branches?.local.length}
        value={current}
        onChange={(event) => select(event.target.value)}
      >
        {!branches?.local.includes(current) && (
          <option value={current} disabled>
            {current || tx("分支读取失败")}
          </option>
        )}
        {branches?.local.map((branch) => (
          <option key={branch} value={branch}>
            {branch}
          </option>
        ))}
      </select>
    </label>
  );
}
