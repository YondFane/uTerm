export function autoCloseAgent(agent: string | undefined, code: number | null) {
  return !!agent && code === 0;
}

export async function closeAttachedSession(
  connection: { closed: boolean; ready: Promise<void> },
  terminate: () => Promise<void>,
) {
  if (connection.closed) return false;
  connection.closed = true;
  try {
    await connection.ready;
    await terminate();
    return true;
  } catch (error) {
    // Retain the attachment for retry; a failed close does not prove process termination.
    // 保留连接供重试；关闭失败不能证明进程已终止。
    connection.closed = false;
    throw error;
  }
}
