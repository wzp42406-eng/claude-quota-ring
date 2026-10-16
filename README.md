# Claude 额度环 · claude-quota-ring

在 Claude 界面里直接看到额度还剩多少，不用再打开 Settings → Usage。

Show your remaining Claude usage (5-hour and 7-day windows) right in the Claude UI.

| 部分 | 显示位置 | 适用 |
| --- | --- | --- |
| [`extension/`](extension) | claude.ai 左下角名字右侧的空白处：同心圆额度环（外圈 5h、内圈 7d），悬停显示详情 | Chrome / Arc / Edge 里的 claude.ai |
| [`claude-code-mod/`](claude-code-mod) | Claude Code 输入框上方：与网页一致的同心圆（外圈 5h 灰、内圈 7d 红）+ `62%` | Claude Code 终端版与桌面 App 的 Code 页 |

## 浏览器扩展

- 名字右侧显示一组同心圆：**外圈是 5 小时额度**（灰色，取 Claude 的中性灰），**内圈是 7 天额度**（红色），弧长代表剩余量；右侧只显示 5 小时剩余百分比（沿用「Pro」的字号，与名字同一行、垂直居中）；7 天余量只用内圈表示，不显示数字。
- 鼠标悬停弹出卡片，显示两个窗口的剩余量和重置时间。
- 颜色和字体沿用 claude.ai 自己的 CSS 变量，跟随浅色和深色主题；空间不够时只保留圆环。
- 只请求 claude.ai 自己的 `/api/organizations` 和 `/api/organizations/<id>/usage`，每 2 分钟刷新一次。不收集、不上传任何数据。

### AI 用量统计（v0.8.0）

- **名字右侧**：只放额度圆环和 5 小时剩余百分比。
- **名字下方一行**：当前网站的使用时长和 token，如 `今日 1h12m · 4.0k tokens`。在 claude.ai 显示 Claude 的，在 chatgpt.com 显示 ChatGPT 的。**点一下这一行**可以在 今日 → 本周 → 本月 → 今年 → 累计 之间切换，浏览器会记住你选的区间。
- **悬停卡片**：当前区间里 Claude、ChatGPT 各自的数字和合计，下面是其他区间的两者合计。
- 数据按天永久保存在本机扩展存储里，不会每天清零。周从周一算起。
- 时长：页面在前台、窗口有焦点，并且 3 分钟内有操作（或正在生成回复）才计时。
- Token：只统计在页面上实时发出和生成的消息（打开历史对话不会重复计），按文字估算：中日韩字符约 1 字 1 token，其他约 4 字符 1 token。**这是估算**，不含系统提示、联网/文件内容和每轮重复发送的上下文，比官方计费的 token 少。

### 本机用量 API（给个人工作台用）

[`usage-api/`](usage-api) 是一个只监听 `127.0.0.1:8787` 的小服务（只用 Python 标准库）。扩展会把用量同步过去；没装这个服务时扩展照常工作。

安装成开机自动运行，并显示你的专属密钥：

```bash
bash usage-api/install.sh
```

以后需要再看密钥时运行 `python3 usage-api/server.py --key`；`--new-key` 会换一个新密钥，旧的立即失效。卸载服务：`bash usage-api/install.sh --uninstall`（数据会保留）。

接口（都要带 `Authorization: Bearer <密钥>`）：

| 接口 | 返回 |
| --- | --- |
| `GET /api/usage` | `periods.day / week / month / year / all`，每项含 `claude`、`chatgpt`、`total` 的 `minutes` 和 `tokens` |
| `GET /api/usage/daily?from=2026-10-01&to=2026-10-31` | 按天明细 |
| `GET /health` | 不需要密钥，检查服务是否在运行 |

在工作台网页里调用：

```js
const r = await fetch('http://127.0.0.1:8787/api/usage', {
  headers: { Authorization: 'Bearer <你的密钥>' },
})
const { periods } = await r.json()
console.log(periods.month.total.minutes, periods.month.total.tokens)
```

- 数据文件在 `~/Library/Application Support/ai-usage/usage.json`。
- 只有浏览器扩展能写入；同步时按天取较大值，所以重装扩展、清空扩展存储也不会冲掉已有记录。
- 只能在这台 Mac 上访问。在线网页（https）也能读，Chrome 会自动做本机访问的预检。

## Claude Code 插件（quota-band）

和网页扩展同一种表现：同心圆外圈是 5 小时额度（灰）、内圈是 7 天额度（红），弧长代表剩余量，旁边只显示 5 小时剩余百分比。桌面 App 的 Code 页用矢量圆环；终端用盲文点阵画圆环（占 3 行，空间不够时退化为 `◔ 62%`）。数据来自 Claude Code 自己记录的额度窗口，每次回复后更新。

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
- 扩展依赖 claude.ai / chatgpt.com 的内部接口和页面结构，官方改版后可能失效，欢迎提 issue。
- 用量统计只覆盖浏览器里的网页版；桌面 App、手机 App 和 Claude Code 里的使用不计入。
- 额度只对订阅账号（Pro / Max / Team）有意义；API Key 用户看不到圆环。

## 许可证

MIT
