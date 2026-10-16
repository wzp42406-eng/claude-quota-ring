import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { describe, untilReset } from '../hooks/register'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('countdown formats days, hours and minutes', async () => {
  const now = Date.parse('2026-10-16T00:00:00Z')
  expect(untilReset('2026-10-16T00:45:00Z', now)).toBe('45分后重置')
  expect(untilReset('2026-10-16T02:13:00Z', now)).toBe('2时13分后重置')
  expect(untilReset('2026-10-18T05:00:00Z', now)).toBe('2天5时后重置')
  expect(untilReset(undefined, now)).toBe('')
})

test('describe shows only the 5-hour window', async () => {
  const now = Date.parse('2026-10-16T00:00:00Z')
  const text = describe(
    [
      { kind: 'five_hour', percentUsed: 37.5, resetsAt: '2026-10-16T02:00:00Z' },
      { kind: 'seven_day', percentUsed: 12 },
    ],
    now,
  )
  expect(text).toBe('5小时额度 剩 63%（2时0分后重置）')
  expect(describe([{ kind: 'seven_day', percentUsed: 12 }], now)).toBe('')
})

test('band appears after a rate-limit measurement on every surface', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine' }) as RenderElement
  })
  mock.clock(on, { now: Date.parse('2026-10-16T00:00:00Z') })
  on('session.measure', (_$, e) => ({ changed: e.changed }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const empty = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND })
    expect(await empty.find({ type: 'Text', text: /5小时额度/ })).toBeUndefined()
  }

  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 40 }, { kind: 'seven_day', percentUsed: 12 }],
    changed: ['rateLimits'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /5小时额度 剩 60%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /7天|88%/ })).toBeUndefined()
  }
})
