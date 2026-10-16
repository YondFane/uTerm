## 中文

- 在“设置”中下载应用更新，网络短暂中断后会有限重试，并在下载源支持时继续未完成的下载；已验证的完整下载可复用。
- Agent 工具和数据库组件下载失败时显示更明确的原因，可从手动下载入口继续；一键安装脚本也支持重试、续传和已校验缓存复用。
- 减少空闲时的后台唤醒和更新包的内存占用，Java 在线安装减少临时磁盘占用；原有会话保护和签名校验继续生效。

## English

- Download application updates from Settings with bounded retries after brief network interruptions and resume when supported by the source. Verified complete downloads can be reused.
- Failed Agent tool and database component downloads show clearer reasons and offer a manual download entry. One-line installers also support retries, resume and verified-cache reuse.
- Reduce background wakeups while idle, update-package memory use and temporary disk use during online Java installation. Existing session protection and signature checks remain in effect.
