export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Today = { minutes: number; tokens: number }

declare module 'claude-code' {
  interface PluginState {
    'quota-band': { limits: Limit[]; today: Today | null }
  }
}
