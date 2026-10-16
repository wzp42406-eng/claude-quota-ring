import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { RASTER, pick, remaining, ringsCells, ringsSvg } from '../hooks/register'

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
    expect(await ui.find({ type: 'Text', text: /^60%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /88%/ })).toBeUndefined()
    expect(await ui.find({ type: surface === 'terminal' ? 'Raster' : 'Svg' })).toBeDefined()
  }
})
