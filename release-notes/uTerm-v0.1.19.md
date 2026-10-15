## 中文

- 数据库工作台支持多个查询标签、当前／选中／全部语句执行、对象补全、格式化和本次运行查询历史。各标签共享连接与事务，使用 Ctrl/Cmd+Enter 执行当前语句或选区，Ctrl/Cmd+Shift+Enter 执行全部。
- 双击表打开数据视图，可使用服务端筛选。开启“允许编辑”后暂存单元格或增删行，点击“预览表格修改”核对 SQL，再应用到事务并显式提交；需要具备主键且支持事务的标量列普通表，冲突保留草稿。
- 在结果区导出已加载页面为 CSV／JSON，或在 SQL 工具栏查看只读查询的执行计划。Oracle 执行计划需开启编辑并具备 PLAN_TABLE／DBMS_XPLAN 权限。
- “复制 SQL”“放弃 SQL 修改”直接平铺；表菜单点击外部或按 Esc 自动关闭。宽表按可见行列渲染，窄窗口分页保持可见，只读浏览复用连接以减少内存占用。

## English

- The database workbench adds query tabs, current/selection/all execution, object completion, formatting and history for this run. Tabs share a connection and transaction; use Ctrl/Cmd+Enter for the current statement or selection and Ctrl/Cmd+Shift+Enter for all statements.
- Double-click a table for data and server-side filters. Enable editing to stage cell changes or row insertions/deletions, preview their SQL, apply to the transaction and explicitly commit. Editing requires a transactional ordinary table with a primary key and supported scalar columns; conflicts retain drafts.
- Export the loaded result page as CSV/JSON, or inspect a read query's execution plan from the SQL toolbar. Oracle plans require editing and PLAN_TABLE/DBMS_XPLAN permissions.
- Copy SQL and Discard SQL changes are directly available; table menus close on outside clicks or Escape. Wide tables render visible rows/columns, narrow windows keep pagination visible, and read-only browsing reuses its connection to reduce memory use.
