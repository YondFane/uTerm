# uTerm 0.1.34

## 中文

- Pull 不再因工作区存在修改而直接拦截。右键点击顶部的分支控件，选择“拉取 Pull（仅快进）”，可保留无冲突的已暂存、未暂存修改及未跟踪文件；会覆盖本地修改或历史分叉时仍由 Git 拒绝操作。Pull 需先配置上游分支。

- 窄侧栏中的终端／Agent 按钮组不再遮挡项目图标和名称。悬停或聚焦项目、Worktree 行时，空间不足的按钮组会浮到右侧；按 Escape 或点击外部可关闭，宽侧栏仍在行内显示。

## English

- Pull no longer blocks solely because the working tree has local changes. Right-click the branch
  control in the toolbar and choose Pull (fast-forward only) to retain unrelated staged, unstaged
  and untracked files. Git still rejects file overwrites and divergent history. Configure the
  branch's upstream before using Pull.

- Terminal/Agent actions no longer cover project icons and names in narrow sidebars. Hover or focus
  a project or Worktree row to float the actions to the right when space is limited; press Escape or
  click outside to dismiss. Wider sidebars keep the actions inline.
