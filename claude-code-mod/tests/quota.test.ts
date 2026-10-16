import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { RASTER, bandText, fmtReset, pick, quotaIsFresh, remaining, ringsCells, ringsSvg } from '../hooks/register'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('remaining turns used into what is left', async () => {
  expect(remaining({ kind: 'five_hour', percentUsed: 37.6 })).toBe(62)
  expect(remaining({ kind: 'five_hour', percentUsed: 120 })).toBe(0)
  expect(remaining(undefined)).toBe(0)
  const { five, seven } = pick([{ kind: 'seven_day', percentUsed: 12 }, { kind: 'five_hour', percentUsed: 40 }])
  expect(five?.percentUsed).toBe(40)
  expect(seven?.percentUsed).toBe(12)
})

test('svg draws an outer gray ring and an inner red ring', async () => {
  const svg = ringsSvg(62, 88)
  expect(svg).toContain('r="8"')
  expect(svg).toContain('r="4.5"')
  expect(svg).toContain('#8f8a80')
  expect(svg).toContain('#d7493c')
})

test('braille raster covers every cell and empties as quota runs out', async () => {
  const cells = (pct5: number, pct7: number) => {
    const bin = atob(ringsCells(pct5, pct7))
    const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0))
    return new Uint32Array(bytes.buffer)
  }
  const full = cells(100, 100)
  expect(full.length).toBe(RASTER.columns * RASTER.rows * 3)
  const dots = (w: Uint32Array) => {
    let n = 0
    for (let i = 0; i < w.length; i += 3) {
      const cp = w[i] ?? 0
      if (cp > 0x2800) n += (cp - 0x2800).toString(2).replace(/0/g, '').length
    }
    return n
  }
  expect(dots(cells(50, 50))).toBeLessThan(dots(full))
  expect(dots(cells(0, 0))).toBe(0)
})

test('band shows rings and only the 5-hour percentage', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine' }) as RenderElement
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  mock.clock(on, { now: Date.parse('2026-10-16T00:00:00Z') })

  for (const surface of ['terminal', 'desktop'] as const) {
    const empty = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND })
    expect(await empty.find({ type: 'Text', text: /%/ })).toBeUndefined()
  }

  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 40 }, { kind: 'seven_day', percentUsed: 12 }],
    changed: ['rateLimits'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /Claude 60%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Codex —/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /88%/ })).toBeUndefined()
    expect(await ui.find({ type: surface === 'terminal' ? 'Raster' : 'Svg' })).toBeDefined()
  }
})

test('Codex formatter keeps quota first, adds resets when space allows, and rejects stale data', async () => {
  const now = Date.parse('2026-10-16T10:00:00+08:00')
  const cx = {
    today: { minutes: 38.8, tokens: 310_000 },
    fiveHour: { remaining_percent: 72, resets_at: '2026-10-16T12:30:00+08:00', observed_at: '2026-10-16T09:59:00+08:00' },
    sevenDay: { remaining_percent: 40, resets_at: '2026-10-20T12:30:00+08:00', observed_at: '2026-10-16T09:59:00+08:00' },
  }
  const full = bandText({ kind: 'five_hour', percentUsed: 67 }, { minutes: 164, tokens: 1_100_000 }, cx, now)
  expect(`${full.claude} ‖ ${full.codex}`).toBe('Claude 33% │ 今日 2h44m · 1.1M ‖ Codex 5h 72% ↻12:30 · 周 40% ↻10/20 12:30 │ 今日 38m · 310k')
  const narrow = bandText({ kind: 'five_hour', percentUsed: 67 }, { minutes: 164, tokens: 1_100_000 }, cx, now, 30)
  expect(`${narrow.claude} ‖ ${narrow.codex}`).toBe('Claude 33% ‖ Codex 5h 72%')
  expect(quotaIsFresh(cx.fiveHour, now)).toBe(true)
  expect(fmtReset(cx.fiveHour.resets_at, now)).toBe('12:30')

  const stale = { ...cx, fiveHour: { ...cx.fiveHour, observed_at: '2026-10-16T04:59:59+08:00' } }
  expect(bandText(undefined, null, stale, now).codex).toBe('Codex —')
  const expired = { ...cx, fiveHour: { ...cx.fiveHour, resets_at: '2026-10-16T09:59:59+08:00' } }
  expect(bandText(undefined, null, expired, now).codex).toBe('Codex —')
})

test('band adds today\'s Claude Code time and tokens from the local usage API', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine' }) as RenderElement
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const clock = mock.clock(on, { now: Date.parse('2026-10-16T00:00:00Z') })
  mock.env(on, { HOME: '/Users/test' })
  const calls: string[] = []
  on('fs.read', (_$, e) => {
    expect(e.path).toBe('/Users/test/Library/Application Support/ai-usage/config.json')
    return { value: JSON.stringify({ key: 'aiu_test' }) }
  })
  on('http.fetch', (_$, e) => {
    calls.push(`${e.init?.method ?? 'GET'} ${e.url} ${e.init?.headers?.Authorization}`)
    const text = e.url.endsWith('/api/usage')
      ? JSON.stringify({
        periods: { day: { claude_code: { minutes: 153.4, tokens: 1_020_000 }, codex: { minutes: 38.2, tokens: 310_000 } } },
        quota: { codex: {
          five_hour: { remaining_percent: 72, resets_at: '2026-10-16T03:00:00Z', observed_at: '2026-10-16T00:00:00Z' },
          seven_day: { remaining_percent: 40, resets_at: '2026-10-20T03:00:00Z', observed_at: '2026-10-16T00:00:00Z' },
        } },
      })
      : '{"ok":true}'
    return { value: { status: 200, ok: true, headers: {}, text } }
  })

  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 40 }, { kind: 'seven_day', percentUsed: 12 }],
    changed: ['rateLimits'],
  })
  expect(calls).toEqual([])
  await clock.advance(1)

  expect(calls).toEqual([
    'POST http://127.0.0.1:8787/api/quota Bearer aiu_test',
    'GET http://127.0.0.1:8787/api/usage Bearer aiu_test',
  ])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /Claude 60%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Codex 5h 72%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /周 40%/ })).toBeDefined()
    if (surface === 'desktop') {
      expect(await ui.find({ type: 'Text', text: /今日 2h33m · 1\.0M/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /今日 38m · 310k/ })).toBeDefined()
    }
  }
})
