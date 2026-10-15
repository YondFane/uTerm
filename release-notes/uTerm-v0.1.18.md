## 中文

- 数据库工作台新增对象树。连接后展开库／模式，筛选已加载对象，双击表打开数据，切换“结构”查看字段；SQL 草稿和查询结果保留。“生成 SELECT”可将表查询写入编辑器，覆盖草稿前需确认。
- 结果表格支持拖动或 Shift+方向键选择区域、选择整行、复制选区或带表头复制，双击单元格查看已加载的完整值。拖动分隔线和列边缘可调整布局、列宽，分页保持在底部。
- 浏览表数据和结构不影响尚未提交的 SQL 事务。开启“允许编辑”后执行 SQL，再显式提交或回滚；浏览连接异常时可重试浏览。
- 修复打开“数据库组件”后项目工具面板挤入侧栏底部的问题，返回项目后恢复原工具及位置。未连接或连接报错时，SQL 编辑区保持可见，可从侧栏或设置管理组件。

## English

- The database workbench adds an object tree. After connecting, expand a catalog/schema, filter loaded objects and double-click a table to open Data; switch to Structure to inspect columns. SQL drafts and query results are retained. Generate SELECT fills the editor after confirming replacement of an unsaved draft.
- Result grids support drag or Shift-arrow range selection, row selection, copying a selection with optional headers and double-click inspection of complete loaded cell values. Drag pane separators and column edges to resize the layout and columns; pagination stays at the bottom.
- Browsing table data and structure preserves pending SQL transactions. Enable editing to execute SQL, then explicitly commit or roll back. Retry browsing if its connection fails.
- Fixed project tools appearing in the sidebar footer when Database components opens; returning to the project restores the selected tool and position. The SQL editor stays visible while disconnected or after a connection error; manage components from the sidebar or Settings.
