// Next Steps: after each turn, 2 or 3 likely next prompts above the input.
// In an empty prompt, the leader key and then 1 to 3 drafts one (nothing sends on its own),
// the leader and 0 dismisses. A bare digit types as usual, so a stray 1 is never a pick.
// Local fork of hamzafer/claude-code-mods next-steps 0.1.1: the leader key and the card are the changes.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NextSteps } from '../types'

const MODEL = 'haiku'
const MAX_ITEMS = 3
const MAX_CHARS = 60 // what the model is asked for
const MAX_KEPT = 120 // a longer line is dropped, never cut: a cut draft would send half a prompt
const MIN_ANSWER = 20 // a reply shorter than this is not worth a model call
const LEADERS = [';', ',', '\\'] // what the person may set the leader to; ; by default
const ROW_COLORS = ['#f472b6', '#a5b4fc', '#5eead4'] // suggestion 1, 2 and 3: bullet, key and compact chip
const ROW_TINTS = ['#f9a8d4', '#c7d2fe', '#99f6e4'] // their text, a shade lighter (as where-am-i's card)
const BORDER = '#fb7185'
const TITLE: [string, string][] = [['Suggested ', '#fdba74'], ['next ', '#f472b6'], ['steps', '#a5b4fc']]
const CARD_ROWS = 5 // the card's rows besides the suggestions: two borders, title, hint, dismiss
const CARD_MIN_COLUMNS = 40 // narrower than this, or shorter than the card, the band draws one compact row
const HEAD = 7 // '✦ next ' and '✦ pick ' in the compact row, and the indent under them

// Held by the host, so the list survives a hot reload of this file.
const steps = atom({ plugin: 'next-steps', key: 'steps' } as const, null as NextSteps | null)
// True while the list is on screen. where-am-i reads it and leaves out its own "next" meanwhile.
const active = atom({ plugin: 'next-steps', key: 'active' } as const, false)
// True while the box holds the leader alone: the band then shows the digits to press.
const armed = atom({ plugin: 'next-steps', key: 'armed' } as const, false)
// The leader as /config set it, for where-am-i to draw the keys with.
const leaderKey = atom({ plugin: 'next-steps', key: 'leader' } as const, ';')
// where-am-i's value, read here: once it hosts the card, the suggestions are drawn inside it, never a card of their own.
const whereHosts = { plugin: 'where-am-i', key: 'hosts' } as const

export const register: Register = (on, options) => {
  const leader = LEADERS.find(l => l === options.leader) ?? ';'
  // The turn a suggestion may still be shown for. A submit or a new turn moves it on.
  let latest = ''
  let submits = 0
  // A survey answers bare digits in the band: leave them to it.
  let hasSurvey = false
  // What `armed` was last written as, so a keystroke that changes nothing writes nothing.
  const arm = { now: false }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await update($, leaderKey, () => leader).catch(() => {})
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    latest = `submit-${++submits}`
    await setSteps($, () => null)
    await setArmed($, arm, false)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    latest = e.turnId
    await setSteps($, () => null)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r // a subagent's turn, not the person's
    latest = e.turnId // also for a turn that raised no turn.start, and after a hot reload
    if (e.reason !== 'answer' || e.answer.trim().length < MIN_ANSWER) return r
    void suggest($, e.turnId, e.answer, () => latest).catch(() => {}) // in the background, so the turn ends at once
    return r
  })

  // The leader typed alone into an empty prompt lands as text; a digit right after it picks a
  // suggestion in its place. A paste carries no key, so a pasted ";1" lands as typed.
  on('prompt.edit', async ($, e, next) => {
    const n = leader.length
    const isPick = !hasSurvey && !!e.key && !e.key.ctrl && !e.key.meta && e.text === leader && e.start === n && e.end === n && /^[0-9]$/.test(e.inputText)
    const s = isPick ? await read($, steps) : null
    if (s && e.inputText === '0') {
      await setSteps($, () => null)
      await setArmed($, arm, false)
      return { text: '', cursor: 0 } // consumed: the leader goes too, the box is empty again
    }
    const pick = s?.items[Number(e.inputText) - 1]
    if (pick) {
      await setArmed($, arm, false)
      return { text: pick, cursor: pick.length } // the leader becomes the draft: the person edits it or presses Enter
    }
    const r = await next(e)
    await setArmed($, arm, r.text === leader)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    hasSurvey = e.props.hasSurvey
    const s = await read($, steps)
    if (e.props.hasSurvey || e.props.isWorking || !s || s.items.length === 0) return rest
    const { value: hosted = false } = await $.state.get(whereHosts)
    if (hosted) return rest // where-am-i draws them in its card

    const isArmed = await read($, armed)
    const { Box, Text } = $.ui.resolve(e)
    // With the leader typed, the keys drop it: only the digit is left to press.
    const key = (n: number) => (isArmed ? `${n}` : `${leader}${n}`)

    // The card: a bordered box, a title, a hint, one row per suggestion with its key on the right.
    if (e.props.maxRows >= s.items.length + CARD_ROWS && e.props.bodyColumns >= CARD_MIN_COLUMNS) {
      const digits = s.items.map((_, i) => `${i + 1}`)
      const choices = digits.length > 1 ? `${digits.slice(0, -1).join(', ')} or ${digits.at(-1)}` : (digits[0] ?? '1')
      const hint = isArmed
        ? `press ${choices} to draft it · 0 dismisses`
        : `${s.items.length} idea${s.items.length === 1 ? '' : 's'} · type ${leader} then a number`
      const row = (bullet: JSX.Element, text: JSX.Element, keyText: JSX.Element) => (
        <Box flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              {bullet}
              {text}
            </Text>
          </Box>
          <Box flexShrink={0} marginLeft={2}>
            {keyText}
          </Box>
        </Box>
      )
      return (
        <Box flexDirection="column">
          <Box flexDirection="column" borderStyle="round" borderColor={isArmed ? 'warning' : BORDER} paddingX={1} width={e.props.bodyColumns}>
            <Text wrap="truncate-end">
              <Text color="#f472b6">{'✧ '}</Text>
              {TITLE.map(([word, color]) => (
                <Text color={color} bold>
                  {word}
                </Text>
              ))}
            </Text>
            <Text wrap="truncate-end" {...(isArmed ? { color: 'warning', bold: true } : { dimColor: true })}>
              {hint}
            </Text>
            {s.items.map((t, i) =>
              row(
                <Text color={ROW_COLORS[i] ?? BORDER}>{'● '}</Text>,
                <Text color={ROW_TINTS[i] ?? BORDER}>{t}</Text>,
                <Text color={ROW_COLORS[i] ?? BORDER} bold>
                  {key(i + 1)}
                </Text>,
              ),
            )}
            {row(<Text dimColor>{'○ '}</Text>, <Text dimColor>{'Dismiss'}</Text>, <Text dimColor>{key(0)}</Text>)}
          </Box>
          {rest}
        </Box>
      )
    }

    // The compact row, for a short or narrow band.
    const head = isArmed ? <Text color="warning" bold>{'✦ pick '}</Text> : <Text color="claude" bold>{'✦ next '}</Text>
    const sep = <Text>{'   '}</Text>
    const item = (text: string, i: number) => [
      <Text backgroundColor={ROW_COLORS[i] ?? BORDER} color="black" bold>{` ${key(i + 1)} `}</Text>,
      <Text>{' '}</Text>,
      <Text color={ROW_TINTS[i] ?? BORDER}>{text}</Text>,
    ]
    const dismiss = [<Text inverse dimColor>{` ${key(0)} `}</Text>, <Text dimColor>{' dismiss'}</Text>]

    const lines =
      // One per row needs a row each; a short band gets the one row, cut at its end.
      fitsOnOneLine(s.items, e.props.bodyColumns, leader) || e.props.maxRows < s.items.length + 2 ? (
        <Text wrap="truncate-end">
          {head}
          {s.items.flatMap((t, i) => [...item(t, i), sep])}
          {dismiss}
        </Text>
      ) : (
        <Box flexDirection="column">
          {s.items.map((t, i) => (
            <Text wrap="truncate-end">
              {i === 0 ? head : <Text>{' '.repeat(HEAD)}</Text>}
              {item(t, i)}
              {i === s.items.length - 1 && sep}
              {i === s.items.length - 1 && dismiss}
            </Text>
          ))}
        </Box>
      )

    return (
      <Box flexDirection="column">
        <Box paddingX={1}>{lines}</Box>
        {rest}
      </Box>
    )
  })
}

// Writes the list, then whether it shows, for where-am-i.
async function setSteps($: EngineInterface, fn: (before: NextSteps | null) => NextSteps | null) {
  const after = await update($, steps, fn)
  const showing = after !== null && after.items.length > 0
  if ((await read($, active)) !== showing) await update($, active, () => showing)
}

// Whether the band holds the leader alone, written only when that changes.
async function setArmed($: EngineInterface, arm: { now: boolean }, value: boolean) {
  if (arm.now === value) return
  arm.now = value
  await update($, armed, () => value)
}

// The whole list on one row, or one suggestion per row when it would not fit.
export function fitsOnOneLine(items: string[], columns: number, leader = ';') {
  const chip = leader.length + 3 // ' ;1 '
  const width = HEAD + items.reduce((n, t) => n + chip + 1 + t.length + 3, 0) + chip + ' dismiss'.length
  return width <= columns - 2 // the band's padding
}

async function suggest($: EngineInterface, turnId: string, answer: string, current: () => string) {
  // Wait for background agents: the main agent picks up again once they finish.
  const agents = await $.agent.list().catch(() => [])
  if (agents.some(a => a.status === 'running')) return

  const all = (await $.session.messages().catch(() => [])).filter(m => m.text.trim() !== '')
  if (all.at(-1)?.role === 'assistant') all.pop() // the latest reply goes in on its own below
  const messages = all.slice(-6)
  const r = await $.model.complete({
    model: MODEL,
    maxTokens: 200,
    timeoutMs: 20_000,
    system:
      'You predict what a person will type next to their coding assistant, after reading a transcript of their session. ' +
      `Give 2 or 3 short, concrete follow-up prompts, each an instruction in the imperative, under ${MAX_CHARS} characters, ` +
      'specific to what just happened (name the file, test or feature). Plain words, no em dashes, no numbering, no quotes. ' +
      'One per line and nothing else. If nothing sensible follows, reply with the single word NONE.\n' +
      'Example reply:\nRun the login tests again\nAdd the same check to signup.ts\nOpen a draft PR',
    prompt: [
      `<transcript>\n${messages.map(m => `[${m.role === 'user' ? 'person' : 'assistant'}] ${m.text.slice(0, 800)}`).join('\n')}\n</transcript>`,
      `<latest_reply>\n${answer.slice(0, 2000)}\n</latest_reply>`,
      'Write the follow-up prompts the person is likely to send next: the lines only, not a reply to the transcript.',
    ].join('\n\n'),
  })
  if (!r.isAnswered) return
  const items = parseSteps(r.text)
  // Checked inside the write, so a submit or a new turn that lands meanwhile always wins.
  await setSteps($, before => (current() !== turnId ? before : items.length > 0 ? { turnId, items } : null))
}

// The model's lines, cleaned: no fences, bullets, numbers or em dashes; at most three.
// A preamble, a "nothing to add" or a line too long to draft whole is dropped.
export function parseSteps(text: string): string[] {
  const body = text.replace(/```[a-z]*\n?/gi, '').trim()
  let lines = body.split('\n')
  if (body.startsWith('[') || body.startsWith('{')) {
    try {
      const o = JSON.parse(body) as unknown
      const arr = Array.isArray(o) ? o : Object.values(o as Record<string, unknown>).find(Array.isArray)
      lines = Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
    } catch {
      // not JSON after all: read it as lines
    }
  }
  const out: string[] = []
  for (const line of lines) {
    const clean = line
      .replace(/\*\*/g, '')
      .replace(/^\s*(?:[-*•]|\d+[.):])\s*/, '')
      .replace(/^["'`]+|["'`,]+$/g, '')
      .replace(/\s*\u2014\s*/g, ', ')
      .replace(/\.$/, '')
      .trim()
    if (clean === '' || clean.endsWith(':') || clean.length > MAX_KEPT) continue
    if (/^(none|no |nothing|here are|here's|sure)/i.test(clean) || /^[[\]{}]$/.test(clean)) continue
    if (!out.some(o => o.toLowerCase() === clean.toLowerCase())) out.push(clean)
    if (out.length === MAX_ITEMS) break
  }
  return out
}
