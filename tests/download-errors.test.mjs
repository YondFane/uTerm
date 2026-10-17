import assert from "node:assert/strict";
import test from "node:test";
import { downloadError } from "../src/lib/download-error.ts";
import { setUiLanguage } from "../src/lib/i18n.ts";

test("download errors distinguish recoverable networks from verification, storage and Agent setup", async () => {
  try {
    for (const [code, english, chinese] of [
      ["DOWNLOAD_NETWORK", /connection was interrupted/, /连接中断/],
      ["DOWNLOAD_STORAGE", /disk space/, /磁盘空间/],
      ["DOWNLOAD_VERIFY", /nothing was installed/, /未安装/],
      ["DOWNLOAD_TLS", /certificate/, /证书/],
      ["DOWNLOAD_NOT_FOUND", /not found/, /不存在/],
      ["DOWNLOAD_ACCESS", /access permissions/, /访问权限/],
      ["DOWNLOAD_RATE_LIMIT", /limiting requests/, /限制请求/],
      ["AGENT_PERMISSION\nnpm error EACCES", /not writable/, /不可写/],
      ["AGENT_NODE_VERSION", /Node.js version/, /Node.js 版本/],
    ]) {
      setUiLanguage("en");
      assert.match(downloadError(code), english);
      setUiLanguage("zh-Hans");
      assert.match(downloadError(code), chinese);
    }
    assert.equal(downloadError("unsaved file"), undefined);
  } finally {
    setUiLanguage("en");
  }
});
