## 中文

- 新增 Hermes、Pi、MiniMax、Qwen Code、Copilot CLI 和 iFlow CLI，并使用各自的品牌图标。在“设置 →
  Agent”安装或配置程序、开启后，即可从项目或添加菜单创建会话。iFlow 已公告停止在线服务，保留 CLI 安装入口不代表其服务可用。
- Pi、MiniMax、Qwen Code、Copilot CLI 和 iFlow CLI 支持安装与移除活动 Hooks；在“设置 →
  Agent”安装后新建会话生效。Hermes 提供手动 Hook 配置说明。重复操作不再生成无用配置或重复备份。
- SSH 新增快速连接、主机搜索和连接详情。快速连接可粘贴 Host 别名或
  `user@host:port`；终端与文件独立连接，点击“远程文件 → 连接文件”后才启动 SFTP。
- SSH 支持配置跳板机和本地端口转发。在连接配置中填写跳板机，在连接顶部“端口转发”中添加并手动启动规则。转发只监听
  `127.0.0.1`；跳板机需使用密钥或 ssh-agent 认证。
- 新增 Elasticsearch 与 MongoDB 文档工作台。从“数据库”添加连接，选择索引或集合，输入 Query
  DSL 或 MongoDB 查询 JSON 后执行；默认只读，开启“允许编辑”后可确认插入、替换或删除。MongoDB 需安装 Java
  17+ 与对应驱动，Elasticsearch 无需额外运行时。
- 修复修改文档查询后沿用旧页码、断开连接时请求未及时结束，以及自定义 Agent 标识误用内置配置的问题。
- 更新中英文下载与开发指南，并在官网提供工作区截图和操作演示，便于了解终端、Agent、项目及数据连接入口。

## English

- Add Hermes, Pi, MiniMax, Qwen Code, Copilot CLI and iFlow CLI with their brand icons. Install or
  configure and enable a program in Settings → Agent, then create sessions from a project or the Add
  menu. iFlow has announced the shutdown of its online service; retaining CLI installation does not
  make that service available.
- Install or remove activity Hooks for Pi, MiniMax, Qwen Code, Copilot CLI and iFlow CLI in Settings
  → Agent, then open a new session. Hermes links to manual Hook setup instructions. Repeated
  operations no longer create unnecessary configuration files or duplicate backups.
- Add SSH quick connections, host search and connection details. Paste a Host alias or
  `user@host:port` into Quick SSH connection. Terminals and files connect independently; select
  Remote files → Connect files to start SFTP.
- Add SSH jump hosts and local port forwarding. Set a jump host in the connection form, then add and
  manually start rules under Port forwarding in the connection header. Forwarding listens only on
  `127.0.0.1`; jump hosts require key or ssh-agent authentication.
- Add Elasticsearch and MongoDB document workbenches. Add a connection under Databases, choose an
  index or collection, and run Query DSL or MongoDB query JSON. Connections start read-only; enable
  editing to confirm inserts, replacements or deletions. MongoDB requires Java 17+ and its drivers;
  Elasticsearch needs no additional runtime.
- Fix stale pagination after document-query edits, requests continuing after disconnection, and
  custom Agent identifiers incorrectly using built-in configuration metadata.
- Update the English and Chinese download and development guides, with workspace screenshots and an
  operation tour on the website to introduce terminal, Agent, project and data connection entry
  points.
