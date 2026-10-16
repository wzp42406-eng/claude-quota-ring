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

[`usage-api/`](usage-api) 是一个只监听 `127.0.0.1:8787` 的小服务（只用 Python 标准库），汇总四个来源：

| 来源 | 字段名 | 数据从哪来 | token |
| --- | --- | --- | --- |
| claude.ai 网页 | `claude` | 浏览器扩展 | 估算 |
| chatgpt.com 网页 | `chatgpt` | 浏览器扩展 | 估算 |
| Claude Code（终端和桌面 App 的 Code 页） | `claude_code` | `~/.claude/projects/` 里的会话记录 | 实际值 |
| Codex（CLI 和桌面） | `codex` | `~/.codex/sessions/` 里的会话记录 | 实际值 |

额度：Claude 的 5 小时 / 7 天额度由 Claude Code 插件和浏览器扩展报上来；Codex 的额度从它的会话记录里读。没装这个服务时，扩展和插件照常工作。

终端里看一眼全部用量：

```bash
python3 usage-api/server.py --summary
```

安装成开机自动运行，并显示你的专属密钥：

```bash
bash usage-api/install.sh
```

以后需要再看密钥时运行 `python3 usage-api/server.py --key`；`--new-key` 会换一个新密钥，旧的立即失效。卸载服务：`bash usage-api/install.sh --uninstall`（数据会保留）。

接口（都要带 `Authorization: Bearer <密钥>`）：

| 接口 | 返回 |
| --- | --- |
| `GET /api/usage` | `periods.day / week / month / year / all`，每项含 `claude`、`chatgpt`、`claude_code`、`codex`、`web_total`、`cli_total`、`total` 的 `minutes`、`tokens`（终端来源另有 `cache_read_tokens`）；`quota.claude / quota.codex` 的 `five_hour`、`seven_day` 剩余百分比与重置时间 |
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
- 写入只接受浏览器扩展和带密钥的本机程序；网页用量同步时按天取较大值，所以重装扩展、清空扩展存储也不会冲掉已有记录。
- 终端 token 的算法：未命中缓存的输入 + 写缓存 + 输出；命中缓存的输入单独记为 `cache_read_tokens`（数量很大但便宜）。时长：同一会话里相邻两条记录间隔不超过 5 分钟的部分相加。
- 只能在这台 Mac 上访问。在线网页（https）也能读，Chrome 会自动做本机访问的预检。

### 个人工作台（公开网站）

公开地址：<https://wzp42406-eng.github.io/ai-workbench/>（谁都能看）。本机也能打开同一个页面：<http://127.0.0.1:8787/>。页面源文件是 [`site/index.html`](site/index.html)，只有两个板块：

- **AI 用量**：今日 / 本周 / 本月 / 今年 / 累计的时长、token、缓存命中；四个来源分别列出；Claude 和 Codex 的 5 小时 / 7 天额度；近 14 天使用时长堆叠柱（悬停看明细，可展开数据表）。
- **英语 · 跟读为主**：一句一句练。`空格` 听原音（可慢速、跟着高亮），`R` 开始 / 结束跟读，读完按语音识别结果给每个词打勾或标红并打分，还能回放自己的录音和原音对比；`←` `→` 换句。自带需求访谈、方案演示、回应异议、会后跟进、日常沟通五组材料，也可以粘贴自己的邮件或演讲稿练。每天目标 10 句，记录练习分钟数和连续天数。
- **生词 · 辅助**：小卡片间隔复习（每天 5 张新卡），可添加、删除。

数据怎么到公开网站：`usage-api/publish.py` 由 launchd 每 12 小时运行一次（`install.sh` 安装，登录时也会跑一次），用本机 `gh` 账号把最新快照 `data.json` 和页面上传到 `wzp42406-eng/ai-workbench` 仓库，GitHub Pages 随即更新。快照只有按天的时长、token 和额度百分比，没有密钥、文件路径或对话内容。手动立刻更新：`python3 usage-api/publish.py`。日志在 `~/Library/Logs/ai-usage-publish.log`。

英语的练习记录和生词存在各自浏览器里（每个访客各有一份，不会上传）。语音评分用浏览器自带的语音识别：Chrome / Edge / Safari 支持，Chrome 会把录音发到 Google 识别；不支持的浏览器仍可录音回放。

## Claude Code 插件（quota-band）

和网页扩展同一种表现：同心圆外圈是 5 小时额度（灰）、内圈是 7 天额度（红），弧长代表剩余量，旁边只显示 5 小时剩余百分比。桌面 App 的 Code 页用矢量圆环；终端用盲文点阵画圆环（占 3 行，空间不够时退化为 `◔ 62%`）。数据来自 Claude Code 自己记录的额度窗口，每次回复后更新。

装了本机用量 API（见上）后，同一行右侧还会显示今天 Claude Code 的使用时长和 token，如 `62%  │  今日 2h33m · 1.0M tokens`（实际值，每次回复后刷新）；插件也会把额度报给 API，工作台就能读到。

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
