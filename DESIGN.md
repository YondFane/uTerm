# uTerm interface / uTerm 界面

## Direction / 设计方向

A quiet desktop workspace for terminals, projects and agents. The visual direction references the restrained surfaces in [Warp's design analysis](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/warp/DESIGN.md), from [Awesome DESIGN.md](https://github.com/VoltAgent/awesome-design-md). This implementation uses original application layouts, local fonts and existing icons; it does not embed third-party branding or remote assets.

面向终端、项目和 Agent 的安静桌面工作空间。视觉参考上述 Warp 设计分析中的克制表面处理。本实现使用独立应用布局、本地字体和现有图标，不嵌入第三方品牌或远程资源。

## Tokens / 设计变量

| Token / 变量 | Dark / 深色 | Light / 浅色 |
| --- | --- | --- |
| Canvas / 画布 | #211f1d | #faf8f5 |
| Sidebar / 侧栏 | #1b1918 | #f0ede7 |
| Surface / 表面 | #2a2724 | #ffffff |
| Border / 边框 | #403b35 | #d9d2c7 |
| Text / 文字 | #f0ebe3 | #302b25 |
| Secondary / 次要文字 | #ada59a | #70665a |
| Accent / 强调 | #d9b987 | #866126 |

The table shows the Sandstone palette. Black (black and silver) is the default. Ocean uses navy and ice blue; Moss uses forest green and mint. Paper uses warm white and terracotta; Clear Sky uses cool white and sky blue. These two always use light interface colors independently of terminal appearance. The other four have dark and light variants, selectable with preview cards in Settings → Appearance. The palette source is `src/lib/interface-themes.ts`, applied through `--ui-*` variables. Terminal ANSI colors remain separate and configurable. Use system sans-serif for controls and monospace for paths and keyboard hints.

表格展示砂岩配色，暗黑（黑色与银灰）为默认主题。深海使用深蓝与冰蓝，青苔使用墨绿与薄荷。纸白使用暖白与陶棕，晴空使用冷白与天蓝，两套固定使用浅色界面且独立于终端外观。其余四套均有深浅变体，可在设置 → 外观中通过预览卡片选择。配色源定义在 `src/lib/interface-themes.ts`，通过 `--ui-*` 变量应用。终端 ANSI 配色独立且可配置。控件使用系统无衬线字体，路径和快捷键提示使用等宽字体。

## Components / 组件

- Keep chrome compact: 56 px toolbars, 5–6 px control corners, one-pixel dividers. Use accent sparingly for selected items and focus.
- 保持紧凑：56 px 工具栏、5–6 px 控件圆角、1 px 分隔线。强调色只突出选中项和焦点。
- The welcome page provides real project, terminal and chat actions. Disable unavailable actions; do not show placeholder metrics or simulated sessions.
- 欢迎页提供真实的项目、终端和聊天入口。不可用操作应禁用，不展示虚构指标或模拟会话。
- Preserve pane geometry, keyboard shortcuts, accessible names and visible focus. Respect reduced-motion preferences. Hide an inspector's column when it has no content.
- 保留窗格布局、快捷键、无障碍名称和可见焦点。遵循减少动态效果偏好。工具面板无内容时不占用列宽。
- Keep both language versions aligned. Use no external fonts, CDN scripts, decorative gradients or marketing illustrations.
- 中英文保持一致。不使用外部字体、CDN 脚本、装饰渐变或营销插画。
