export type Tier = 'haiku' | 'sonnet' | 'opus'

export type Advice = {
  // What Jev picked, and how sure it was (0 to 1)
  pick: Tier
  confidence: number
  // The model the chat was on before this prompt
  current: Tier | 'other'
  // The model this turn runs on (auto mode), or null to leave it alone
  route: Tier | null
  // Why, in plain words
  note: string
  // Advise mode: whether the band offers a switch button
  canSwitch: boolean
  ms: number
}

// What the last finished turn tells us about the chat and its cache
export type LastTurn = { at: number; contextTokens: number; tier: Tier | 'other' }

declare module 'claude-code' {
  interface PluginState {
    'jev-router': {
      last: Advice | null
      isHidden: boolean
      lastTurn: LastTurn | null
    }
  }
}
