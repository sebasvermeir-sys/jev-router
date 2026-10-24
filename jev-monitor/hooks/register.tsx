// jev-monitor: a pane beside the chat that follows jev-router live,
// read from its own log, ~/.jev/router-log.jsonl.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, Snapshot, Tier } from '../types'

const POLL_MS = 3000
const HISTORY = 12

const snapshot = atom({ plugin: 'jev-monitor', key: 'snapshot' } as const, {
  entries: [],
  mode: '?',
  error: null,
} as Snapshot)

const isExpanded = atom({ plugin: 'jev-monitor', key: 'isExpanded' } as const, false)

const LABEL: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', other: '—' }
const COLOR: Record<Tier, string> = { haiku: 'green', sonnet: 'cyan', opus: 'magenta', other: 'gray' }

function time(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function parse(text: string): Entry[] {
  const out: Entry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      // jev-router also logs timeouts and errors (no pick): those are not picks
      if (typeof row.pick !== 'string') continue
      // rows from jev-router 0.1 have no route: nothing was switched then
      out.push({ ...row, route: row.route ?? null } as Entry)
    } catch {
      // a line being written: skip it, the next poll reads it whole
    }
  }
  return out
}

let lastMtime = -1


async function refresh($: EngineInterface) {
  const home = await $.env.get('HOME')
  const path = `${home}/.jev/router-log.jsonl`
  try {
    const rows = await $.config.list()
    const mode = String(rows.find(r => r.key.startsWith('jev-router') && r.key.endsWith('.mode'))?.value ?? '?')
    if (!(await $.fs.exists(path))) {
      await update($, snapshot, s => ({ ...s, mode, error: 'Pas encore de journal Jev.' }))
      return
    }
    const { mtimeMs } = await $.fs.stat(path)
    if (mtimeMs === lastMtime) {
      await update($, snapshot, s => (s.mode === mode ? s : { ...s, mode }))
      return
    }
    lastMtime = mtimeMs
    const entries = parse(await $.fs.read(path))
    await update($, snapshot, () => ({ entries, mode, error: null }))
  } catch (err) {
    await update($, snapshot, s => ({ ...s, error: `Lecture impossible : ${String(err)}` }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'jev', description: 'Déplier ou replier le bandeau Jev' })
    await refresh($)
    $.clock.every(POLL_MS, () => refresh($))
    return next(e)
  })

  on('command.run', { command: 'jev' }, async $ => {
    await refresh($)
    await update($, isExpanded, v => !v)
    return { text: 'Bandeau Jev basculé.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const expanded = await read($, isExpanded)
    const all = s.entries
    const last = all[all.length - 1]

    const counts: Record<Tier, number> = { haiku: 0, sonnet: 0, opus: 0, other: 0 }
    for (const x of all) counts[x.pick] = (counts[x.pick] ?? 0) + 1
    const routed = all.filter(x => x.route !== null && x.route !== x.current).length
    const avgMs = all.length ? Math.round(all.reduce((t, x) => t + x.ms, 0) / all.length) : 0
    const bar = (n: number) => '█'.repeat(all.length ? Math.round((n / all.length) * 20) : 0)

    const used = last ? last.route ?? last.current : null
    const header = (
      <Box flexDirection="row" gap={1}>
        <Button
          label={expanded ? '▾ Jev' : '▸ Jev'}
          onPress={() => update($, isExpanded, v => !v)}
        />
        <Text dimColor>{s.mode}</Text>
        {last && used && (
          <Text>
            <Text color={COLOR[last.pick]}>{LABEL[last.pick]}</Text>
            <Text dimColor> {Math.round(last.confidence * 100)} % → </Text>
            <Text color={COLOR[used]}>{LABEL[used]}</Text>
          </Text>
        )}
      </Box>
    )

    // The bands of the plugins beneath (Ribbon, jev-router…), drawn under ours
    const below = await next(e)

    if (!expanded)
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {below}
        </Box>
      )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {s.error && <Text color="yellow">{s.error}</Text>}

        {last && (
          <Box flexDirection="column">
            <Text bold>Dernier message · {time(last.at)}</Text>
            <Text>
              Jev conseille <Text color={COLOR[last.pick]} bold>{LABEL[last.pick]}</Text> (
              {Math.round(last.confidence * 100)} %)
            </Text>
            <Text>
              Utilisé : <Text color={COLOR[last.route ?? last.current]}>{LABEL[last.route ?? last.current]}</Text>
            </Text>
            <Text dimColor>{last.note} · {last.ms} ms · {last.chars} car.</Text>
          </Box>
        )}

        <Box flexDirection="column">
          <Text bold>Répartition des conseils ({all.length} messages)</Text>
          {(['haiku', 'sonnet', 'opus'] as const).map(t => (
            <Text>
              <Text color={COLOR[t]}>{LABEL[t].padEnd(7)}</Text>
              {bar(counts[t])} {counts[t]}
            </Text>
          ))}
          <Text dimColor>
            Changements de modèle : {routed} · latence moyenne : {avgMs} ms
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>Historique</Text>
          {all.length === 0 && <Text dimColor>Aucun message routé pour l'instant.</Text>}
          {all
            .slice(-HISTORY)
            .reverse()
            .map(x => (
              <Text>
                <Text dimColor>{time(x.at)} </Text>
                <Text color={COLOR[x.pick]}>{LABEL[x.pick].padEnd(7)}</Text>
                {String(Math.round(x.confidence * 100)).padStart(3)} % →{' '}
                {LABEL[x.route ?? x.current]}
              </Text>
            ))}
        </Box>
        {below}
      </Box>
    )
  })
}
