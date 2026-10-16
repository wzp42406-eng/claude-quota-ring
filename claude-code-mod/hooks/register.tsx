import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit } from '../types'

const limits = atom({ plugin: 'quota-band', key: 'limits' } as const, [] as Limit[])

export const untilReset = (resetsAt: string | undefined, now: number) => {
  if (!resetsAt) return ''
  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000))
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}天${Math.floor((minutes % 1440) / 60)}时后重置`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}时${minutes % 60}分后重置`
  return `${minutes}分后重置`
}

// 只显示 5 小时额度；7 天额度不在这一行显示
export const describe = (list: readonly Limit[], now: number) => {
  const five = list.find(l => l.kind === 'five_hour')
  if (!five) return ''
  const left = Math.max(0, Math.round(100 - five.percentUsed))
  const reset = untilReset(five.resetsAt, now)
  return `5小时额度 剩 ${left}%${reset ? `（${reset}）` : ''}`
}

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
    const five = list.find(l => l.kind === 'five_hour')
    if (e.props.hasSurvey || !five) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const used = five.percentUsed

    return (
      <Box>
        <Text dimColor={used < 80} color={used >= 90 ? 'red' : used >= 80 ? 'yellow' : undefined}>
          {describe(list, await $.clock.now())}
        </Text>
      </Box>
    )
  })
}
