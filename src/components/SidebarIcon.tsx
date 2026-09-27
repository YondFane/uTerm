import { useUiLanguage } from "../lib/useUiLanguage";
import { tx } from "../lib/i18n";
import type { SessionConfig } from "../lib/workspace";

export const agentNames: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini",
  kimi: "Kimi",
  grok: "Grok",
};
export function AgentStatusIndicator({ state = "idle" }: { state?: string }) {
  useUiLanguage();

  const label: Record<string, string> = {
    idle: tx("空闲"),
    working: tx("工作中"),
    waiting: tx("需要处理"),
    done: tx("已完成"),
    error: tx("已退出"),
  };
  return (
    <span
      className={`agent-state ${state}`}
      role="img"
      title={label[state]}
      aria-label={label[state]}
    />
  );
}

// Keep these vendor marks in sync with uTermShared/BrandIcons.swift.
const brands = {
  claude:
    "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  codex:
    "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z",
};

type IconName =
  | "folder"
  | "folderClosed"
  | "terminal"
  | "sidebarRight"
  | "sidebar"
  | "chevron"
  | "plus"
  | "more"
  | "branch";
export function SidebarIcon({ name }: { name: IconName }) {
  useUiLanguage();

  const paths: Record<IconName, string> = {
    folder: "M3 8V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v1M3 8h5l2 3h11l-2 8H5a2 2 0 0 1-2-2Z",
    folderClosed: "M3 7V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
    terminal: "M8 9l3 3-3 3m6 0h3M8 3h8q5 0 5 5v8q0 5-5 5H8q-5 0-5-5V8q0-5 5-5Z",
    sidebarRight: "M8 3h8q5 0 5 5v8q0 5-5 5H8q-5 0-5-5V8q0-5 5-5Zm7 0v18",
    sidebar: "M8 3h8q5 0 5 5v8q0 5-5 5H8q-5 0-5-5V8q0-5 5-5Zm1 0v18M5.5 7h1m-1 3h1",
    chevron: "m8 5 7 7-7 7",
    plus: "M12 5v14M5 12h14",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    branch:
      "M6 8v8m12-8a7 7 0 0 1-7 7H6M6 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM6 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  };
  return (
    <svg
      className={`sidebar-icon icon-${name}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function SessionIcon({ agent }: { agent?: SessionConfig["agent"] }) {
  useUiLanguage();

  if (!agent || !["codex", "claude", "gemini"].includes(agent))
    return <SidebarIcon name="terminal" />;
  return (
    <svg
      className={`sidebar-icon agent-${agent}`}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d={
          agent === "gemini"
            ? "M12 1C11 8 8 11 1 12c7 1 10 4 11 11 1-7 4-10 11-11C16 11 13 8 12 1Z"
            : brands[agent as keyof typeof brands]
        }
      />
    </svg>
  );
}

const toolbarPaths = {
  compare: "M12 3v18M3 7h6L6 4m3 3-3 3m15 7h-6l3-3m-3 3 3 3",
  previous: "m14 6-6 6 6 6",
  next: "m10 6 6 6-6 6",
  expandAll: "m7 6 5 5 5-5m-10 7 5 5 5-5",
  collapseAll: "m7 11 5-5 5 5m-10 7 5-5 5 5",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 8v6m0-10v.01",
  command: "M5 7l4 5-4 5m7 0h7",
  settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
  agent: "M9 3h6m-3 0v3M5 7h14v13H5ZM8 11v2m8-2v2m-7 4h6M2 11v5m20-5v5",
  github:
    "M9 19c-4 1-4-2-6-2m12 5v-4c0-1-.3-1.7-1-2 3-.3 6-1.5 6-6 0-1.3-.4-2.3-1.2-3.2.2-1 .1-2-.3-3-1.5 0-3 .7-3.8 1.3a13 13 0 0 0-6.4 0C7.5 4.5 6 3.8 4.5 3.8c-.4 1-.5 2-.3 3C3.4 7.7 3 8.7 3 10c0 4.5 3 5.7 6 6-.7.3-1 1-1 2v4",
  files: "M8 3h8l4 4v13H8ZM16 3v5h4M4 7v15h12",
  newFile: "M5 3h9l4 4v4M14 3v5h4M5 3v18h7m5-7v8m-4-4h8",
  newFolder: "M3 7V5h6l2 2h10v6M3 7v13h9m5-6v8m-4-4h8",
  splitRight: "M3 4h18v16H3Zm9 0v16",
  splitDown: "M3 4h18v16H3Zm0 8h18",
  maximize: "M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6",
  restore: "M3 9h6V3m6 0v6h6M9 21v-6H3m18 0h-6v6",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6",
  quick: "M5 3h10l4 4v14H5ZM14 3v5h5M8 12h7m-7 4h4",
  tree: "M4 3v14h4M4 7h4m3-3h9v6h-9Zm0 10h9v6h-9Z",
  close: "m6 6 12 12M6 18 18 6",
  remove: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6m4-6v6",
  link: "M9 15l6-6m-5-3 2-2a5 5 0 0 1 7 7l-2 2m-3 5-2 2a5 5 0 0 1-7-7l2-2",
  restart: "M20 7v5h-5m5 0a8 8 0 1 0-2 6",
} as const;
export function ToolbarIcon({ name }: { name: keyof typeof toolbarPaths | "git" }) {
  useUiLanguage();

  if (name === "git") return <SidebarIcon name="branch" />;
  return (
    <svg
      className="toolbar-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={toolbarPaths[name]} />
    </svg>
  );
}
