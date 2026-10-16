# Claude 额度环 · claude-quota-ring

在 Claude 界面里直接看到额度还剩多少，不用再打开 Settings → Usage。

Show your remaining Claude usage (5-hour and 7-day windows) right in the Claude UI.

| 部分 | 显示位置 | 适用 |
| --- | --- | --- |
| [`extension/`](extension) | claude.ai 左下角头像那一行：一个小圆环加剩余百分比，悬停显示详情 | Chrome / Arc / Edge 里的 claude.ai |
| [`claude-code-mod/`](claude-code-mod) | Claude Code 输入框上方一行：`5小时 剩 62%（3时12分后重置） · 7天 剩 88%` | Claude Code 终端版与桌面 App 的 Code 页 |

## 浏览器扩展

- 圆环显示 5 小时和 7 天两个窗口里更紧的那个；鼠标悬停显示两个窗口的剩余量和重置时间。
- 颜色和字体沿用 claude.ai 自己的 CSS 变量，跟随浅色和深色主题；剩余量 ≤10% 时变红。
- 只请求 claude.ai 自己的 `/api/organizations` 和 `/api/organizations/<id>/usage`，每 2 分钟刷新一次。不收集、不上传任何数据。

安装：
1. 下载本仓库（Code → Download ZIP 并解压，或 `git clone`）
2. 打开 `chrome://extensions`，开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择 `extension` 文件夹
4. 刷新 claude.ai

## Claude Code 插件（quota-band）

数据来自 Claude Code 自己记录的额度窗口（每次回复后更新），用量 ≥80% 变黄，≥90% 变红。

在 Claude Code 终端里：

```
/plugin install quota-band --marketplace wzp42406-eng/claude-quota-ring
```

或在 shell 里：

```bash
claude plugin install quota-band --marketplace wzp42406-eng/claude-quota-ring
```

桌面 App 里 `/plugin` 不可用：点输入框旁的 +，选 Plugins → Add marketplace，填 `wzp42406-eng/claude-quota-ring`，再 Add plugin。

## 限制

- Claude 桌面 App 的聊天界面不支持浏览器扩展，扩展只在浏览器里的 claude.ai 生效。
- 扩展依赖 claude.ai 的内部接口和页面结构，官方改版后可能失效，欢迎提 issue。
- 额度只对订阅账号（Pro / Max / Team）有意义；API Key 用户看不到圆环。

## 许可证

MIT
