## 中文

- Redis 新建 Key 支持 List、Set 和 ZSet。连接后开启“允许编辑”，点击“新 Key”选择类型，填写首个成员并保存。
- 在成员表中添加、编辑或删除成员：List 可在开头／末尾添加及按索引修改，Set 可替换成员，ZSet 可修改成员和分数。List 按索引修改／删除支持最多 10000 个成员、全部值合计不超过 1
  MB；更大的列表仍可浏览及添加。
- 成员编辑保留已有 TTL，保存失败保留草稿；Set／ZSet 替换成员时不会覆盖已有目标。切换成员、翻页和关闭编辑区会保护未保存修改，删除成员前展示目标并确认。

## English

- Create Redis List, Set and ZSet keys. Connect, enable Allow editing, choose New key and select a
  type, then enter and save the initial member.
- Add, edit or delete members from the member table. Lists support start/end additions and
  index-based edits, Sets support member replacement, and ZSets support member and score changes.
  List index edits/deletions support up to 10,000 members and 1 MB of combined values; larger lists
  remain browsable and accept additions.
- Member edits preserve existing TTLs and retain drafts when saving fails. Set/ZSet replacements
  refuse an existing destination member. Changing members, paging or closing the editor protects
  unsaved changes; member deletion shows the target for confirmation.
