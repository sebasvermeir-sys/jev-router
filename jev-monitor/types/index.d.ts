export type Tier = 'haiku' | 'sonnet' | 'opus' | 'other'
export type Entry = {
  at: number
  mode: string
  pick: Tier
  confidence: number
  current: Tier
  route: Tier | null
  note: string
  ms: number
  chars: number
}
export type Snapshot = { entries: Entry[]; mode: string; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'jev-monitor': { snapshot: Snapshot; isExpanded: boolean }
  }
}
