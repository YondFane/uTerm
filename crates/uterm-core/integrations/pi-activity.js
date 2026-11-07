// uTerm activity hooks v1 / uTerm 活动 Hooks v1
import { execFile } from "node:child_process";

const reporter = __UTERM_REPORTER__;

function report(state) {
  if (
    !process.env.UTERM_DESKTOP_HOST ||
    !process.env.UTERM_DESKTOP_SESSION ||
    !process.env.UTERM_DESKTOP_GENERATION
  )
    return;
  return new Promise((resolve, reject) => {
    const child = execFile(
      reporter,
      ["--agent-report", state],
      { timeout: 10000, windowsHide: true },
      (error) => (error ? reject(error) : resolve()),
    );
    // The reporter drains hook input before sending its authenticated state update.
    // 上报程序读完 Hook 输入后才发送认证状态更新。
    child.stdin?.end();
  });
}

export default function (pi) {
  pi.on("session_start", () => report("idle"));
  pi.on("agent_start", () => report("working"));
  pi.on("tool_execution_start", () => report("working"));
  pi.on("agent_settled", () => report("done"));
}
