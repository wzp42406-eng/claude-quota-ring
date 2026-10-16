import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit } from '../types'

const limits = atom({ plugin: 'quota-band', key: 'limits' } as const, [] as Limit[])

const LABELS: Record<string, string> = { five_hour: '5小时', seven_day: '7天', spend_limit: '消费' }

export const untilReset = (resetsAt: string | undefined, now: number) => {
  if (!resetsAt) return ''
  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000))
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}天${Math.floor((minutes % 1440) / 60)}时后重置`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}时${minutes % 60}分后重置`
  return `${minutes}分后重置`
}

export const describe = (list: Limit[], now: number) =>
  list
    .map(l => {
      const left = Math.max(0, Math.round((100 - l.percentUsed) * 10) / 10)
      const reset = untilReset(l.resetsAt, now)
      return `${LABELS[l.kind] ?? l.kind} 剩 ${left}%${reset ? `（${reset}）` : ''}`
    })
    .join(' · ')

async function store($: EngineInterface, list: readonly Limit[]) {
  if (list.length === 0) return
  await update($, limits, () => list.map(l => ({ ...l })))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await store($, (await $.session.usage()).rateLimits)
    return result
  })

  on('session.measure', async ($, e, next) => {
    await store($, e.rateLimits)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, limits)
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const worst = Math.max(...list.map(l => l.percentUsed))

    return (
      <Box>
        <Text dimColor={worst < 80} color={worst >= 90 ? 'red' : worst >= 80 ? 'yellow' : undefined}>
          额度 {describe(list, await $.clock.now())}
        </Text>
      </Box>
    )
  })
}
