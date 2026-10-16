import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Codex, CodexQuota, Limit, Today } from '../types'

// 与网页扩展一致：同心圆，外圈 5 小时（灰）、内圈 7 天（红），弧长 = 剩余量；文字只显示 5 小时剩余百分比
// 同一行再显示 Claude Code / Codex 的额度与今日用量（本机 API 汇总会话记录里的实际值）
const limits = atom({ plugin: 'quota-band', key: 'limits' } as const, [] as Limit[])
const today = atom({ plugin: 'quota-band', key: 'today' } as const, null as Today | null)
const codex = atom({ plugin: 'quota-band', key: 'codex' } as const, null as Codex | null)

const API = 'http://127.0.0.1:8787'
const REFETCH_MS = 20_000
const CODEX_FRESH_MS = 5 * 60 * 60 * 1000

const GRAY = 0x8f8a80
const DEFAULT = 0x01000000

export const remaining = (l: Limit | undefined) => (l ? Math.max(0, Math.min(100, Math.round(100 - l.percentUsed))) : 0)

export const pick = (list: readonly Limit[]) => ({
  five: list.find(l => l.kind === 'five_hour'),
  seven: list.find(l => l.kind === 'seven_day'),
})

// ---------- 桌面：SVG 同心圆 ----------
export function ringsSvg(five: number) {
  const arc = (r: number, pct: number, color: string) => {
    const c = 2 * Math.PI * r
    return (
      `<circle cx="10" cy="10" r="${r}" fill="none" stroke="#8f8a80" stroke-opacity="0.2" stroke-width="2"/>` +
      `<circle cx="10" cy="10" r="${r}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" ` +
      `stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(2)}" transform="rotate(-90 10 10)"/>`
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">${arc(8, five, '#8f8a80')}</svg>`
}

// ---------- 终端：盲文点阵同心圆（6 列 × 3 行 = 12 × 12 点）----------
export const RASTER = { columns: 6, rows: 3 }
const DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

// 某点是否落在弧上：从 12 点方向顺时针，覆盖剩余比例
const onArc = (dx: number, dy: number, pct: number) => {
  const a = Math.atan2(dx, -dy)
  const turn = (a < 0 ? a + 2 * Math.PI : a) / (2 * Math.PI)
  return turn < pct / 100
}

export function ringsCells(five: number) {
  const { columns, rows } = RASTER
  const bits = new Array<number>(columns * rows).fill(0)
  const color = new Array<number>(columns * rows).fill(DEFAULT)
  const c = 5.5
  for (let y = 0; y < rows * 4; y++) {
    for (let x = 0; x < columns * 2; x++) {
      const dx = x - c
      const dy = y - c
      const d = Math.hypot(dx, dy)
      // 外圈只落在边缘的格子，内圈只落在中间两格，同一格不会混色
      const ring = d >= 4.6 && d <= 5.9 ? { pct: five, rgb: GRAY } : null
      if (!ring || !onArc(dx, dy, ring.pct)) continue
      const i = Math.floor(y / 4) * columns + Math.floor(x / 2)
      bits[i] = (bits[i] ?? 0) | (DOT_BITS[y % 4]?.[x % 2] ?? 0)
      color[i] = ring.rgb
    }
  }
  const words = new Uint32Array(columns * rows * 3)
  bits.forEach((b, i) => {
    words[i * 3] = b ? 0x2800 + b : 0x20
    words[i * 3 + 1] = color[i] ?? DEFAULT
    words[i * 3 + 2] = DEFAULT
  })
  return toBase64(new Uint8Array(words.buffer))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function toBase64(bytes: Uint8Array) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? B64[n & 63]! : '=')
  }
  return out
}

async function store($: EngineInterface, list: readonly Limit[]) {
  if (list.length === 0) return
  await update($, limits, () => list.map(l => ({ ...l })))
}

export const fmtTime = (minutes: number) => {
  const m = Math.floor(minutes)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : String(n)

const displayWidth = (s: string) => [...s].reduce((n, ch) => n + (ch.codePointAt(0)! > 0x2e80 ? 2 : 1), 0)

export const quotaIsFresh = (q: CodexQuota | undefined, now: number) => {
  const seen = Date.parse(q?.observed_at ?? '')
  const reset = Date.parse(q?.resets_at ?? '')
  const age = now - seen
  return Number.isFinite(seen) && age >= -5 * 60 * 1000 && age <= CODEX_FRESH_MS && (!Number.isFinite(reset) || reset > now)
}

export const fmtReset = (value: string | null | undefined, now: number) => {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!match) return ''
  const [, year, month, day, hour, minute] = match
  const local = new Date(now)
  const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
  const date = `${year}-${month}-${day}`
  return date === today ? `${hour}:${minute}` : `${month}/${day} ${hour}:${minute}`
}

type BandText = { claude: string; codex: string }

// 同一行按可用宽度降级，优先级：5h 主数字 > 周余量 > 今日用量 > 重置时间。
export function bandText(five: Limit | undefined, claudeToday: Today | null, cx: Codex | null, now: number, columns = Infinity): BandText {
  // 只显示 5 小时额度：周额度和重置时间都不显示，保持一眼能读完
  const left5 = five ? remaining(five) : null
  const claudeQuota = left5 === null ? 'Claude —' : `Claude ${left5}%`
  const claudeUsage = claudeToday ? ` · 今日 ${fmtTime(claudeToday.minutes)} · ${fmtTok(claudeToday.tokens)}` : ''
  const fresh5 = quotaIsFresh(cx?.fiveHour, now)
  const codexQuota = fresh5 ? `Codex ${Math.round(cx!.fiveHour!.remaining_percent)}%` : 'Codex —'
  const codexUsage = fresh5 && cx?.today ? ` · 今日 ${fmtTime(cx.today.minutes)} · ${fmtTok(cx.today.tokens)}` : ''
  const candidates: BandText[] = [
    { claude: claudeQuota + claudeUsage, codex: codexQuota + codexUsage },
    { claude: claudeQuota, codex: codexQuota },
  ]
  return candidates.find(x => displayWidth(`${x.claude}${SEP}${x.codex}`) <= columns) ?? candidates.at(-1)!
}

export const SEP = '  │  '

// ---------- 本机用量 API（usage-api/server.py）：没装就什么都不做 ----------
let apiKey: string | undefined
let fetchedAt = 0

async function key($: EngineInterface) {
  if (apiKey) return apiKey
  const home = await $.env.get('HOME')
  if (!home) return undefined
  try {
    apiKey = JSON.parse(await $.fs.read(`${home}/Library/Application Support/ai-usage/config.json`) as string).key
  } catch {
    /* 没装用量 API */
  }
  return apiKey
}

// 把额度报给 API（工作台能看到），再取回 Claude Code / Codex 的今日用量与 Codex 额度。
// Codex 仍由 usage-api/collect.py 扫会话记录，插件不直接碰 ~/.codex。
async function syncApi($: EngineInterface, list: readonly Limit[]) {
  const k = await key($)
  if (!k) return
  const headers = { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }
  try {
    if (list.length) {
      await $.http.fetch(`${API}/api/quota`, {
        method: 'POST', headers, body: JSON.stringify({ source: 'claude', limits: list }),
      })
    }
    const now = await $.clock.now()
    if (now - fetchedAt < REFETCH_MS) return
    fetchedAt = now
    const r = await $.http.fetch(`${API}/api/usage`, { headers })
    if (!r.ok) return
    const data = JSON.parse(r.text)
    const day = data?.periods?.day?.claude_code
    if (day) await update($, today, () => ({ minutes: day.minutes, tokens: day.tokens }))
    const cx = data?.periods?.day?.codex
    const quota = data?.quota?.codex
    if (cx || quota) {
      await update($, codex, () => ({
        today: { minutes: cx?.minutes ?? 0, tokens: cx?.tokens ?? 0 },
        fiveHour: quota?.five_hour,
        sevenDay: quota?.seven_day,
      }))
    }
  } catch {
    /* API 没开或返回不是 JSON */
  }
}

// 网络刷新放到独立的时钟任务；ui.render 只读 atom，不会拖慢输入框。
function refresh($: EngineInterface, list: readonly Limit[]) {
  $.clock.after(1, () => { void syncApi($, list) })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const list = (await $.session.usage()).rateLimits
    await store($, list)
    refresh($, list)
    return result
  })

  // 每次回复后都会量一次：顺便刷新今天的用量
  on('session.measure', async ($, e, next) => {
    await store($, e.rateLimits)
    refresh($, e.changed.includes('rateLimits') ? e.rateLimits : [])
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { five } = pick(await read($, limits))
    const used = await read($, today)
    const cx = await read($, codex)
    if (e.props.hasSurvey || (!five && !used && !cx)) return next(e)

    const left5 = remaining(five)
    const now = await $.clock.now()
    const width = e.surface === 'terminal' ? Math.max(20, e.props.bodyColumns - (five && e.props.maxRows >= RASTER.rows ? RASTER.columns + 2 : 0)) : Infinity
    const text = bandText(five, used, cx, now, width)
    const alt = [five && `Claude 5 小时额度剩 ${left5}%`, used && `今日 Claude Code 使用 ${fmtTime(used.minutes)}、${fmtTok(used.tokens)} tokens`, text.codex]
      .filter(Boolean).join('，')

    if (e.surface === 'terminal') {
      const { Box, Text, Raster } = $.ui.resolve(e)
      if (!five || e.props.maxRows < RASTER.rows) {
        return (
          <Box flexDirection="row"><Text dimColor>{text.claude}{SEP}{text.codex}</Text></Box>
        )
      }
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Raster key="rings" columns={RASTER.columns} rows={RASTER.rows} cells={ringsCells(left5)} />
          <Text dimColor>{text.claude}{SEP}{text.codex}</Text>
        </Box>
      )
    }

    if (e.surface === 'desktop' || e.surface === 'mobile' || e.surface === 'vscode') {
      const { Box, Text, Svg } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          {five ? <Svg key="rings" source={ringsSvg(left5)} alt={alt} width={20} height={20} /> : null}
          <Text dimColor>{text.claude}{SEP}{text.codex}</Text>
        </Box>
      )
    }

    return next(e)
  })
}
