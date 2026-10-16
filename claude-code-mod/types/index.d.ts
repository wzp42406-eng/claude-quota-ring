export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Today = { minutes: number; tokens: number }
export type CodexQuota = {
  remaining_percent: number
  resets_at?: string | null
  observed_at?: string | null
}
export type Codex = {
  today: Today
  fiveHour?: CodexQuota
  sevenDay?: CodexQuota
}

declare module 'claude-code' {
  interface PluginState {
    'quota-band': { limits: Limit[]; today: Today | null; codex: Codex | null }
  }
}
