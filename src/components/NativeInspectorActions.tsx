import { ToolbarIcon } from "./SidebarIcon";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";

export function NativeInspectorActions({
  active,
  command,
}: {
  active: "files" | "git" | "github";
  command: (kind: string) => void;
}) {
  useUiLanguage();
  return (
    <div className="inspector-switcher" role="group" aria-label={tx("工具面板")}>
      {(
        [
          ["files", "files", tx("文件")],
          ["git", "git", "Git"],
          ["github", "github", "GitHub"],
          ["directory", "folder", tx("工作目录")],
        ] as const
      ).map(([kind, icon, label]) => (
        <button
          key={kind}
          className="toolbar-icon-button"
          aria-label={label}
          title={label}
          aria-pressed={kind === active}
          onClick={() => command(kind)}
        >
          <ToolbarIcon name={icon} />
        </button>
      ))}
    </div>
  );
}
