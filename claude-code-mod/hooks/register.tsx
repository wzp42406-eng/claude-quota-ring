import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Today } from '../types'

// 与网页扩展一致：同心圆，外圈 5 小时（灰）、内圈 7 天（红），弧长 = 剩余量；文字只显示 5 小时剩余百分比
// 右侧再显示今天 Claude Code 的使用时长和 token（来自本机用量 API，读的是会话记录里的实际值）
const limits = atom({ plugin: 'quota-band', key: 'limits' } as const, [] as Limit[])
const today = atom({ plugin: 'quota-band', key: 'today' } as const, null as Today | null)

const API = 'http://127.0.0.1:8787'
const REFETCH_MS = 20_000

const GRAY = 0x8f8a80
const RED = 0xd7493c
const DEFAULT = 0x01000000

export const remaining = (l: Limit | undefined) => (l ? Math.max(0, Math.min(100, Math.round(100 - l.percentUsed))) : 0)

export const pick = (list: readonly Limit[]) => ({
  five: list.find(l => l.kind === 'five_hour'),
  seven: list.find(l => l.kind === 'seven_day'),
})

// ---------- 桌面：SVG 同心圆 ----------
export function ringsSvg(five: number, seven: number) {
  const arc = (r: number, pct: number, color: string) => {
    const c = 2 * Math.PI * r
    return (
      `<circle cx="10" cy="10" r="${r}" fill="none" stroke="#8f8a80" stroke-opacity="0.2" stroke-width="2"/>` +
      `<circle cx="10" cy="10" r="${r}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" ` +
      `stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(2)}" transform="rotate(-90 10 10)"/>`
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">${arc(8, five, '#8f8a80')}${arc(4.5, seven, '#d7493c')}</svg>`
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

export function ringsCells(five: number, seven: number) {
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
      const ring = d >= 4.6 && d <= 5.9 ? { pct: five, rgb: GRAY } : d >= 1.4 && d <= 2.4 ? { pct: seven, rgb: RED } : null
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

// 把额度报给 API（工作台能看到），再取回今天 Claude Code 的时长和 token
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
    const day = JSON.parse(r.text)?.periods?.day?.claude_code
    if (day) await update($, today, () => ({ minutes: day.minutes, tokens: day.tokens }))
  } catch {
    /* API 没开或返回不是 JSON */
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const list = (await $.session.usage()).rateLimits
    await store($, list)
    await syncApi($, list)
    return result
  })

  // 每次回复后都会量一次：顺便刷新今天的用量
  on('session.measure', async ($, e, next) => {
    await store($, e.rateLimits)
    await syncApi($, e.changed.includes('rateLimits') ? e.rateLimits : [])
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { five, seven } = pick(await read($, limits))
    const used = await read($, today)
    if (e.props.hasSurvey || (!five && !used)) return next(e)

    const left5 = remaining(five)
    const left7 = remaining(seven)
    const label = five ? `${left5}%` : ''
    const usage = used ? `今日 ${fmtTime(used.minutes)} · ${fmtTok(used.tokens)} tokens` : ''
    const alt = [five && `5 小时额度剩 ${left5}%`, seven && `7 天额度剩 ${left7}%`, used && `今日 Claude Code 使用 ${usage.slice(3)}`]
      .filter(Boolean).join('，')

    if (e.surface === 'terminal') {
      const { Box, Text, Raster } = $.ui.resolve(e)
      if (!five || e.props.maxRows < RASTER.rows) {
        return (
          <Box flexDirection="row" gap={2}>
            {five ? <Text color="gray">◔ {label}</Text> : null}
            {usage ? <Text dimColor>{usage}</Text> : null}
          </Box>
        )
      }
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Raster key="rings" columns={RASTER.columns} rows={RASTER.rows} cells={ringsCells(left5, left7)} />
          <Text color="gray">{label}</Text>
          {usage ? <Text dimColor>  │  {usage}</Text> : null}
        </Box>
      )
    }

    if (e.surface === 'desktop' || e.surface === 'mobile' || e.surface === 'vscode') {
      const { Box, Text, Svg } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          {five ? <Svg key="rings" source={ringsSvg(left5, left7)} alt={alt} width={20} height={20} /> : null}
          {five ? <Text dimColor>{label}</Text> : null}
          {usage ? <Text dimColor>{five ? '  ·  ' : ''}{usage}</Text> : null}
        </Box>
      )
    }

    return next(e)
  })
}
