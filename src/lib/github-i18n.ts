import { tx } from "./i18n.ts";
export function githubStatus(value?: string) {
  const labels: Record<string, string> = {
    OPEN: tx("开放"),
    CLOSED: tx("已关闭条目"),
    MERGED: tx("已合并"),
    MERGEABLE: tx("可合并"),
    CONFLICTING: tx("存在冲突"),
    UNKNOWN: tx("未知"),
    APPROVED: tx("已批准"),
    CHANGES_REQUESTED: tx("要求修改"),
    REVIEW_REQUIRED: tx("需要审查"),
    SUCCESS: tx("成功"),
    FAILURE: tx("失败"),
    ERROR: tx("错误"),
    PENDING: tx("等待中"),
    EXPECTED: tx("等待中"),
    QUEUED: tx("已排队"),
    IN_PROGRESS: tx("运行中"),
    COMPLETED: tx("已完成"),
    CANCELLED: tx("已取消"),
    SKIPPED: tx("已跳过"),
    NEUTRAL: tx("中性"),
    TIMED_OUT: tx("已超时"),
    ACTION_REQUIRED: tx("需要处理"),
    STALE: tx("已过期"),
    STARTUP_FAILURE: tx("启动失败"),
  };
  return value ? (labels[value.toUpperCase()] ?? value) : "";
}
