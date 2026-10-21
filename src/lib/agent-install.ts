export const agentHookAgents = [
  "claude",
  "codex",
  "gemini",
  "pi",
  "minimax",
  "qwen",
  "copilot",
  "iflow",
];
export const agentInstallers: Record<
  string,
  {
    program?: string;
    package?: string;
    npmArgs?: string[];
    script?: boolean;
    hookGuide?: string;
    url: string;
  }
> = Object.assign(Object.create(null), {
  opencode: { package: "opencode-ai", url: "https://opencode.ai/docs/" },
  claude: {
    package: "@anthropic-ai/claude-code",
    url: "https://code.claude.com/docs/en/setup",
  },
  codex: { package: "@openai/codex", url: "https://developers.openai.com/codex/cli" },
  gemini: {
    package: "@google/gemini-cli",
    url: "https://geminicli.com/docs/get-started/installation/",
  },
  kimi: { url: "https://www.kimi.com/code/docs/en/" },
  hermes: {
    script: true,
    hookGuide: "https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks/",
    url: "https://hermes-agent.nousresearch.com/docs/getting-started/installation/",
  },
  pi: {
    package: "@earendil-works/pi-coding-agent",
    url: "https://pi.dev/",
  },
  minimax: {
    program: "mcode",
    package: "@minimax-ai/code",
    npmArgs: [
      "--ignore-scripts=false",
      "--include=optional",
      "--allow-scripts=@minimax-ai/code,better-sqlite3",
    ],
    url: "https://agent.minimax.io/docs/cli/quick-start",
  },
  qwen: {
    package: "@qwen-code/qwen-code",
    url: "https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/",
  },
  copilot: {
    package: "@github/copilot",
    url: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
  },
  iflow: {
    package: "@iflow-ai/iflow-cli",
    url: "https://docs.iflow.cn/cli/quickstart/",
  },
  trae: {
    program: "traecli",
    script: true,
    url: "https://docs.trae.cn/cli_get-started-with-trae-cli-2",
  },
});
