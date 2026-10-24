// jev-router: before each prompt runs, ask TypeSafe Jev which Claude model
// it needs.
// - auto (default): the turn's model requests go to that model, no click.
// - advise: only shows the advice, with a button to switch for next time.
// - off: does nothing.
// Pick the mode in /config (jev-router: Mode).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Advice, LastTurn, Tier } from '../types'

const last = atom({ plugin: 'jev-router', key: 'last' } as const, null as Advice | null)
const isHidden = atom({ plugin: 'jev-router', key: 'isHidden' } as const, false)
const lastTurn = atom({ plugin: 'jev-router', key: 'lastTurn' } as const, null as LastTurn | null)

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const KEYCHAIN_SERVICE = 'typesafe-jev'
// Jev gets at most 1.5 s; past that the prompt goes on without advice
const TIMEOUT_MS = 1500
// A smaller model needs Jev to be this sure
const MIN_CONFIDENCE = 0.7
// A bigger model needs less: Jev is less sure on hard prompts, and a
// too-small model costs quality while a too-big one only costs money
const MIN_UPGRADE_CONFIDENCE = 0.45
// The prompt cache stays warm for about an hour in this app
const CACHE_TTL_MS = 55 * 60 * 1000
// A chat this small costs next to nothing to re-read on another model
const SMALL_CONTEXT_TOKENS = 20000
// Never move a chat bigger than this down, even with a cold cache
const MAX_DOWNGRADE_TOKENS = 100000
// Jev needs an extra header past long inputs, so send the first part only
const MAX_PROMPT_CHARS = 4000

const MODEL_ID: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}
const ORDER: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2 }

const CRITERIA: Record<Tier, string> = {
  haiku: 'Simple, fixed-step task: spelling, formatting, renaming, a short factual lookup, filing a note, a yes/no question.',
  sonnet: 'Moderate task: drafting or editing text, summarizing, routine coding, a clear multi-step task with known steps.',
  opus: 'Hard task: planning, architecture, research, debugging something unclear, judgment calls, ambiguous or open-ended goals.',
}

// The key is read once per load: from the macOS Keychain, else ~/.jev/api_key
let apiKey: string | undefined

function tierOf(model: string): Tier | 'other' {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('opus')) return 'opus'
  return 'other'
}

function label(t: Tier | 'other'): string {
  return t === 'other' ? 'this model' : t.charAt(0).toUpperCase() + t.slice(1)
}

async function readKey($: EngineInterface): Promise<string | undefined> {
  if (apiKey) return apiKey
  try {
    const r = await $.process.run(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { timeoutMs: 3000 })
    if (r.exitCode === 0 && r.stdout.trim()) apiKey = r.stdout.trim()
  } catch {}
  if (!apiKey) {
    try {
      const home = await $.env.get('HOME')
      const text = await $.fs.read(`${home}/.jev/api_key`)
      if (text.trim()) apiKey = text.trim()
    } catch {}
  }
  return apiKey
}

// One JSON line per prompt in ~/.jev/router-log.jsonl, newest 1,000 kept
async function log($: EngineInterface, row: object): Promise<void> {
  try {
    const home = await $.env.get('HOME')
    const path = `${home}/.jev/router-log.jsonl`
    let old = ''
    try {
      old = await $.fs.read(path)
    } catch {}
    const lines = old.split('\n').filter(Boolean).slice(-999)
    lines.push(JSON.stringify(row))
    await $.fs.write(path, lines.join('\n') + '\n')
  } catch {}
}

export const register: Register = (on, options) => {
  const mode = String(options.mode ?? 'auto')
  if (mode === 'off') return

  // The model this turn's requests go to; null leaves the engine's choice
  let route: Tier | null = null

  on('prompt.submit', async ($, e, next) => {
    // Only your own typed prompts: no slash commands, hidden or plugin prompts
    const kind = e.origin.kind
    const isOwnPrompt = kind === 'composer' || kind === 'bridge' || kind === 'sdk'
    if (!isOwnPrompt || e.command || e.isMeta || !e.text.trim()) return next(e)

    const turn = await read($, lastTurn)
    // The model the chat is really on: the one that answered last, else the picker's
    const sessionTier = tierOf(await $.session.model())
    const current = turn && turn.tier !== 'other' ? turn.tier : sessionTier
    // Until Jev answers, stay on the model the cache is warm for
    route = current === 'other' ? null : current

    const key = await readKey($)
    if (!key) {
      $.ui.status('Jev: no API key found (see README)')
      return next(e)
    }

    const startedAt = await $.clock.now()
    const request = $.http
      .fetch(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'jev-latest',
          state: e.text.slice(0, MAX_PROMPT_CHARS),
          questions: {
            model: {
              type: 'choice',
              criteria: CRITERIA,
              instructions: 'Pick the smallest Claude model that would handle this prompt well.',
            },
          },
        }),
      })
      .catch(() => null)
    const timeout = $.clock.sleep(TIMEOUT_MS).then(() => null)
    const res = await Promise.race([request, timeout])
    const ms = Math.round((await $.clock.now()) - startedAt)

    if (!res || !res.ok) {
      $.ui.status(res ? `Jev: error ${res.status}` : 'Jev: too slow, skipped')
      await log($, { at: startedAt, error: res ? res.status : 'timeout', ms })
      return next(e)
    }

    try {
      const answer = JSON.parse(res.text).answers.model as { choice: Tier; confidence: number }
      const tokens = turn?.contextTokens ?? 0
      const isCold = turn === null || startedAt - turn.at > CACHE_TTL_MS
      const isSmall = tokens < SMALL_CONTEXT_TOKENS
      const isUpgrade = current !== 'other' && ORDER[answer.choice] > ORDER[current]
      const needed = isUpgrade ? MIN_UPGRADE_CONFIDENCE : MIN_CONFIDENCE

      let note: string
      let isCheap = false
      if (answer.choice === current) {
        note = 'right model'
      } else if (answer.confidence < needed) {
        note = `not sure enough, stays on ${label(current)}`
      } else if (isUpgrade) {
        note = 'needs a bigger model'
        isCheap = true
      } else if (isSmall || (isCold && tokens < MAX_DOWNGRADE_TOKENS)) {
        note = isSmall ? 'chat is small, switching is cheap' : 'cache is cold, switching is cheap'
        isCheap = true
      } else {
        note = `cache is warm (${Math.round(tokens / 1000)}k tokens), stays on ${label(current)}`
      }

      if (mode === 'auto' && (isCheap || answer.choice === current)) route = answer.choice
      const advice: Advice = {
        pick: answer.choice,
        confidence: answer.confidence,
        current,
        route: mode === 'auto' ? route : null,
        note,
        canSwitch: mode === 'advise' && isCheap,
        ms,
      }
      await update($, last, () => advice)
      await update($, isHidden, () => false)
      $.ui.status(undefined)
      await log($, { at: startedAt, mode, ...advice, chars: e.text.length })
    } catch {
      $.ui.status('Jev: could not read the answer')
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Auto mode: send every request of the main turn to the routed model
  if (mode === 'auto') {
    on('turn.step', async function* ($, e, next) {
      const target = route
      if (e.agentId !== undefined || target === null || tierOf(e.model) === target) {
        return yield* next(e)
      }
      // Haiku takes no effort setting; the bigger models keep the session's
      const effort = target === 'haiku' ? undefined : e.effort
      return yield* next({ ...e, model: MODEL_ID[target], effort })
    })
  }

  // Remember how big the chat is, when it last ran and on which model
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const u = result.usage
    if (u) {
      const contextTokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      const at = await $.clock.now()
      await update($, lastTurn, () => ({ at, contextTokens, tier: tierOf(u.model) }))
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const advice = await read($, last)
    if (e.props.hasSurvey || advice === null || (await read($, isHidden))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const pct = Math.round(advice.confidence * 100)
    const headline =
      advice.route !== null
        ? `Jev → ${label(advice.route)}${advice.route === advice.pick ? '' : ` (picked ${label(advice.pick)})`} (${pct}%)`
        : `Jev: ${label(advice.pick)} ${advice.pick === advice.current ? '✓' : 'would do'} (${pct}%)`

    return (
      <Box>
        <Text>{headline}</Text>
        <Text dimColor>
          {' '}· {advice.note} · {advice.ms} ms{' '}
        </Text>
        {advice.canSwitch ? (
          <Button
            key="switch"
            variant="primary"
            label={`Use ${label(advice.pick)} next`}
            onPress={async () => {
              await $.command.run({ command: 'model', args: advice.pick })
              await update($, isHidden, () => true)
            }}
          />
        ) : null}
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
