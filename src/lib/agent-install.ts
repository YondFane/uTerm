export const agentInstallers: Record<string, { package?: string; url: string }> = {
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
};
