// Where Am I: a live recap above the prompt (goal, now, waiting on you, next), plus /where.
// Local fork of hamzafer/claude-code-mods where-am-i 0.1.4, with next-steps 0.1.1 folded in:
// after each turn, 2 or 3 likely next prompts inside the same card (the `nextSteps` option
// turns them off). In an empty prompt the leader key and then 1 to 3 drafts one (nothing sends
// on its own), the leader and 0 dismisses; a bare digit types as usual.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NextSteps, Recap } from '../types'

const MODEL = 'haiku'
const MAX_LOG = 20
const MAX_ITEMS = 3
const MAX_CHARS = 60 // what the model is asked for, per suggestion
const MAX_KEPT = 120 // a longer suggestion is dropped, never cut: a cut draft would send half a prompt
const MIN_ANSWER = 20 // a reply shorter than this is not worth a suggestions call
const LEADERS = [';', ',', '\\'] // what the leader may be set to; ; by default

// Held by the host, so they survive a hot reload of this file.
const recap = atom({ plugin: 'where-am-i', key: 'recap' } as const, null as Recap | null)
const live = atom({ plugin: 'where-am-i', key: 'live' } as const, '')
// The pulse's step, moved on a timer while a turn runs so the blocks beside Working travel.
const frame = atom({ plugin: 'where-am-i', key: 'frame' } as const, 0)
// The suggested next prompts for the last turn, or null.
const steps = atom({ plugin: 'where-am-i', key: 'steps' } as const, null as NextSteps | null)
// True while the prompt holds the leader alone: the card then shows the digits to press.
const armed = atom({ plugin: 'where-am-i', key: 'armed' } as const, false)

const PINK = '#f472b6'
const BORDER = '#fb7185'
const PALETTE = ['#fdba74', '#f472b6', '#c4b5fd', '#93c5fd'] // the goal's words, in turn
const PULSE = ['#831843', '#be185d', '#ec4899', '#f9a8d4'] // the blocks beside Working
const PULSE_MS = 150 // one step of the pulse
const ROW_COLORS = ['#f472b6', '#a5b4fc', '#5eead4'] // suggestion 1, 2 and 3
const ROW_TINTS = ['#f9a8d4', '#c7d2fe', '#99f6e4'] // their text, a shade lighter
// Each row in its own color, as the auto-model bar colors its values: now pink, done green,
// waiting yellow, next lavender. The bullet and status in the full color, the text a tint of it.
const TONE = {
  working: { mark: '#f472b6', text: '#f9a8d4' },
  done: { mark: '#34d399', text: '#a7f3d0' },
  waiting: { mark: '#fbbf24', text: '#fde68a' },
  next: { mark: '#c4b5fd', text: '#ddd6fe' },
} as const
const HEADING: [string, string][] = [['Suggested ', '#fdba74'], ['next ', '#f472b6'], ['steps', '#c4b5fd']]
const CARD_MIN_COLUMNS = 40

let pulse: { cancel: () => void } | null = null

// Steps the pulse while the turn runs; the tick stops itself once the turn is over.
function startPulse($: EngineInterface) {
  if (pulse) return
  pulse = $.clock.every(PULSE_MS, () => void tick($).catch(() => {}))
}

async function tick($: EngineInterface) {
  if ((await read($, live)) === '') return stopPulse()
  await update($, frame, n => (n + 1) % PULSE.length)
}

function stopPulse() {
  pulse?.cancel()
  pulse = null
}

export const register: Register = (on, options) => {
  const suggests = options.nextSteps !== false
  const leader = LEADERS.find(l => l === options.leader) ?? ';'
  let prompt = ''
  let log: string[] = []
  // The turn a suggestion may still be shown for. A submit or a new turn moves it on.
  let latest = ''
  let submits = 0
  // A survey answers bare digits in the band: leave them to it.
  let hasSurvey = false
  // What `armed` was last written as, so a keystroke that changes nothing writes nothing.
  const arm = { now: false }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'where', description: 'Recap the session so far in a few bullets' }).catch(() => {}) // a name Claude Code already has is refused: start anyway
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    prompt = e.text.slice(0, 1500)
    log = []
    latest = `submit-${++submits}`
    await update($, steps, () => null)
    await setArmed($, arm, false)
    await update($, live, () => 'reading your message')
    startPulse($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    latest = e.turnId
    await update($, steps, () => null)
    return next(e)
  })

  // Observe only: note what is happening, then let the call run untouched.
  // Only Claude's own calls count: one another mod makes in the background (`$.tool.call`,
  // `$.mcp.call`) is raised by that plugin, and `next.origin` names it instead of the engine.
  on('tool.call', async ($, e, next) => {
    if (next.origin.plugin !== 'engine') return next(e)
    const line = describe(e as unknown as Record<string, unknown>)
    log = [...log, e.agentId ? `(agent) ${line}` : line].slice(-MAX_LOG)
    if (!e.agentId) await update($, live, () => line)
    const r = await next(e)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r // a subagent's turn, not the person's
    await update($, live, () => '')
    stopPulse()
    void summarize($, prompt, log, e.answer).catch(() => {}) // in the background, so the turn ends at once
    latest = e.turnId // also for a turn that raised no turn.start, and after a hot reload
    if (suggests && e.reason === 'answer' && e.answer.trim().length >= MIN_ANSWER) {
      void suggest($, e.turnId, e.answer, () => latest).catch(() => {})
    }
    return r
  })

  // The leader typed alone into an empty prompt lands as text; a digit right after it picks a
  // suggestion in its place. A paste carries no key, so a pasted ";1" lands as typed.
  if (suggests) {
    on('prompt.edit', async ($, e, next) => {
      const n = leader.length
      const isPick = !hasSurvey && !!e.key && !e.key.ctrl && !e.key.meta && e.text === leader && e.start === n && e.end === n && /^[0-9]$/.test(e.inputText)
      const s = isPick ? await read($, steps) : null
      if (s && e.inputText === '0') {
        await update($, steps, () => null)
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
  }

  on('command.run', { command: 'where' }, async $ => ({ text: await longRecap($, prompt, log) }))

  // One card above the prompt, like the auto-model bar: the goal as its title; now, waiting on
  // you and next as rows with their status on the right; and, once a turn ends, the suggested
  // next steps inside the same box. A band too short or narrow for it gets compact lines.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    hasSurvey = e.props.hasSurvey
    const r = await read($, recap)
    const s = suggests ? await read($, steps) : null
    if (e.props.hasSurvey || (!r && !s?.items.length)) return rest

    const { Box, Button, Text } = $.ui.resolve(e)
    const doing = await read($, live)
    const busy = e.props.isWorking || doing !== ''
    const now = clip(doing || r?.now || '')
    const items = busy ? [] : (s?.items ?? [])
    const isArmed = items.length > 0 && (await read($, armed))
    const nextStep = items.length > 0 ? '' : (r?.next ?? '') // the suggestions stand in for next
    const waiting = busy ? '' : (r?.waiting ?? '') // a stale ask while Claude works again

    const row = (left: JSX.Element[], right: JSX.Element[]) => (
      <Box flexDirection="row">
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{left}</Text>
        </Box>
        <Box flexShrink={0} marginLeft={2}>
          <Text>{right}</Text>
        </Box>
      </Box>
    )
    const title = r && (
      <Text wrap="truncate-end">
        <Text color={PINK}>{'✧ '}</Text>
        {words(r.goal).map((w, i) => (
          <Text color={PALETTE[i % PALETTE.length] ?? PINK} bold>
            {w}
          </Text>
        ))}
      </Text>
    )
    const tone = busy ? TONE.working : TONE.done
    const step = busy ? await read($, frame) : 0 // read only while busy, so an idle card is not redrawn
    const working = [...PULSE.map((_, i) => <Text color={PULSE[(i - step + PULSE.length) % PULSE.length]}>{'▇'}</Text>), <Text color={TONE.working.mark} bold>{'  Working'}</Text>]
    const nowLeft = [<Text color={tone.mark}>{busy ? '● ' : '✓ '}</Text>, <Text color={tone.text} {...(busy ? { bold: true } : {})}>{now}</Text>]
    const rows: JSX.Element[] = []
    if (now !== '') rows.push(row(nowLeft, busy ? working : [<Text color={TONE.done.mark} bold>{'Done'}</Text>]))
    if (waiting !== '') rows.push(row([<Text color={TONE.waiting.mark}>{'◆ '}</Text>, <Text color={TONE.waiting.text}>{clip(waiting)}</Text>], [<Text color={TONE.waiting.mark} bold>{'Waiting on you'}</Text>]))
    if (nextStep !== '') rows.push(row([<Text color={TONE.next.mark}>{'○ '}</Text>, <Text color={TONE.next.text}>{clip(nextStep)}</Text>], [<Text color={TONE.next.mark} bold>{'Next'}</Text>]))

    const hint = isArmed ? <Text color="warning" bold>{`press ${choices(items.length)} · 0 dismisses`}</Text> : <Text dimColor>{`click one, or type ${leader} then a number`}</Text>
    // The number on a filled keycap-like square that a click presses; the leader stays out of it.
    const badge = (n: number, color: string, onPress: () => void) => (
      <Button key={`pick-${n}`} label={`${n}`} onPress={onPress}>
        <Text backgroundColor={color} color="black" bold>{` ${n} `}</Text>
      </Button>
    )
    const rowB = (left: JSX.Element[], right: JSX.Element) => (
      <Box flexDirection="row">
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{left}</Text>
        </Box>
        <Box flexShrink={0} marginLeft={2}>
          {right}
        </Box>
      </Box>
    )
    // The badges, shared by the card and the compact lines: a pick drafts its suggestion, 0 hides them.
    const pick = (i: number) => badge(i + 1, ROW_COLORS[i] ?? PINK, () => void $.prompt.fill({ text: items[i] ?? '' }).catch(() => {}))
    const dismiss = badge(0, '#6b7280', () => void update($, steps, () => null).catch(() => {}))
    const suggestions = items.length === 0 ? [] : [
      row([<Text color={PINK}>{'✦ '}</Text>, ...HEADING.map(([w, c]) => <Text color={c} bold>{w}</Text>)], [hint]),
      ...items.map((t, i) => rowB([<Text color={ROW_COLORS[i] ?? PINK}>{'● '}</Text>, <Text color={ROW_TINTS[i] ?? PINK}>{t}</Text>], pick(i))),
      rowB([<Text dimColor>{'○ '}</Text>, <Text dimColor>{'Dismiss'}</Text>], dismiss),
    ]

    // Two borders, the title and the rows; a blank row between the recap and the suggestions if it fits.
    const tight = 2 + (title ? 1 : 0) + rows.length + suggestions.length
    const fits = fitsCard(tight, e.props.maxRows, e.props.bodyColumns)
    const spaced = fits && suggestions.length > 0 && rows.length > 0 && tight + 1 <= e.props.maxRows
    if (fits) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="column" borderStyle="round" borderColor={isArmed ? 'warning' : BORDER} paddingX={1} width={e.props.bodyColumns}>
            {title}
            {rows}
            {spaced && <Text>{' '}</Text>}
            {suggestions}
          </Box>
          {rest}
        </Box>
      )
    }

    // Compact: the title, one line for now / waiting / next, one row of key chips.
    const dot = <Text dimColor>{'  ·  '}</Text>
    const status = [
      ...(now !== '' ? [<Text color={tone.mark}>{busy ? '● ' : '✓ '}</Text>, <Text color={tone.text}>{now}</Text>] : []),
      ...(waiting !== '' ? [dot, <Text color={TONE.waiting.mark} bold>{'◆ waiting on you: '}</Text>, <Text color={TONE.waiting.text}>{clip(waiting)}</Text>] : []),
      ...(nextStep !== '' ? [dot, <Text color={TONE.next.mark} bold>{'next: '}</Text>, <Text color={TONE.next.text}>{clip(nextStep)}</Text>] : []),
    ]
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" paddingX={1}>
          {title}
          {status.length > 0 && <Text wrap="truncate-end">{[<Text>{'  '}</Text>, ...status]}</Text>}
          {items.length > 0 && (
            // The same badges as the card, each text giving way first where the band is narrow.
            <Box flexDirection="row">
              <Box flexShrink={0}>
                <Text color={isArmed ? 'warning' : PINK} bold>{isArmed ? '✦ pick ' : '✦ next '}</Text>
              </Box>
              {items.flatMap((t, i) => [
                <Box flexShrink={0}>{pick(i)}</Box>,
                <Box flexShrink={1} marginRight={2}>
                  <Text color={ROW_TINTS[i] ?? PINK} wrap="truncate-end">{` ${t}`}</Text>
                </Box>,
              ])}
              <Box flexShrink={0}>{dismiss}</Box>
              <Box flexShrink={1}>
                <Text dimColor wrap="truncate-end">{' dismiss'}</Text>
              </Box>
            </Box>
          )}
        </Box>
        {rest}
      </Box>
    )
  })
}

// Whether the bordered card fits: enough rows for all of it, and wide enough.
export function fitsCard(rows: number, maxRows: number, columns: number) {
  return columns >= CARD_MIN_COLUMNS && rows <= maxRows
}

// Whether the prompt holds the leader alone, written only when that changes.
async function setArmed($: EngineInterface, arm: { now: boolean }, value: boolean) {
  if (arm.now === value) return
  arm.now = value
  await update($, armed, () => value)
}

// The goal's words, each to take the next color of the title's palette.
export function words(goal: string): string[] {
  const all = clip(goal).split(' ').filter(w => w !== '')
  return all.map((w, i) => (i < all.length - 1 ? `${w} ` : w))
}

// "1, 2 or 3" for three suggestions.
export function choices(n: number): string {
  const digits = Array.from({ length: Math.max(1, n) }, (_, i) => `${i + 1}`)
  return digits.length > 1 ? `${digits.slice(0, -1).join(', ')} or ${digits.at(-1)}` : (digits[0] ?? '1')
}

// A short label for one tool call: what a person would say Claude is doing.
export function describe(e: Record<string, unknown>): string {
  const tool = String(e.tool)
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const file = (p: string) => p.split('/').slice(-2).join('/')
  if (tool === 'Bash') return `running ${s('description') || s('command').slice(0, 60)}`
  if (tool === 'Edit' || tool === 'Write') return `editing ${file(s('file_path'))}`
  if (tool === 'Read') return `reading ${file(s('file_path'))}`
  if (tool === 'Grep' || tool === 'Glob') return `searching for ${s('pattern').slice(0, 40)}`
  if (tool === 'Agent') return `starting an agent: ${s('description')}`
  if (tool === 'AskUserQuestion') return 'asking you a question'
  if (tool.startsWith('mcp__')) return `using ${tool.split('__').slice(1).join(' ')}`
  return `using ${tool}`
}

async function summarize($: EngineInterface, prompt: string, log: string[], answer: string) {
  const before = await read($, recap)
  const r = await $.model.complete({
    model: MODEL,
    maxTokens: 300,
    system:
      'You keep a one-glance recap of a coding session for someone with ADHD. Plain words, no em dashes, ' +
      'each field at most 70 characters. Reply with JSON only: {"goal","now","waiting","next"}. ' +
      '"goal": the overall aim of the session (keep the previous goal unless it clearly changed). ' +
      '"now": what was just done. "waiting": what the assistant is waiting on from the person, or "". ' +
      '"next": the next step.',
    prompt: [
      `Previous recap: ${before ? JSON.stringify(before) : 'none'}`,
      `The person's latest message: ${prompt}`,
      `Tools used this turn: ${log.join('; ') || 'none'}`,
      `The assistant's reply: ${answer.slice(0, 2500)}`,
    ].join('\n\n'),
  })
  if (!r.isAnswered) return
  const parsed = parseRecap(r.text)
  if (parsed) await update($, recap, () => parsed)
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
  await update($, steps, before => (current() !== turnId ? before : items.length > 0 ? { turnId, items } : null))
}

async function longRecap($: EngineInterface, prompt: string, log: string[]) {
  const messages = (await $.session.messages()).slice(-12)
  const r = await $.model.complete({
    model: MODEL,
    maxTokens: 500,
    system:
      'Write a recap of this coding session for someone who lost track. Plain words, no em dashes. ' +
      'At most 6 short bullets: the goal, what is done, what is happening now, what is waiting on them, the next step.',
    prompt: [
      `<transcript>\n${messages.filter(m => m.text.trim() !== '').map(m => `[${m.role === 'user' ? 'person' : 'assistant'}] ${m.text.slice(0, 800)}`).join('\n')}\n</transcript>`,
      `Latest message: ${prompt}`,
      `Recent tool calls: ${log.join('; ') || 'none'}`,
      'Write the recap of the transcript above now: the bullets only, not a reply to it.',
    ].join('\n\n'),
  })
  return r.isAnswered ? r.text : 'Could not build a recap right now.'
}

// At most 70 characters, cut at a word: the model does not always keep to the limit.
export function clip(text: string, max = 70) {
  const first = text.split(/(?<=[.!?])\s/)[0] ?? text // one sentence
  if (first.length <= max) return first.replace(/\.$/, '')
  return `${first.slice(0, first.lastIndexOf(' ', max - 1))}…`
}

// The model's JSON, tolerating a code fence around it.
export function parseRecap(text: string): Recap | null {
  const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    const o = JSON.parse(body) as Record<string, unknown>
    const field = (k: string) => (typeof o[k] === 'string' ? clip((o[k] as string).replace(/\s*—\s*/g, ', ').trim()) : '')
    if (!field('goal')) return null
    return { goal: field('goal'), now: field('now'), waiting: field('waiting'), next: field('next') }
  } catch {
    return null
  }
}

// The model's suggestion lines, cleaned: no fences, bullets, numbers or em dashes; at most three.
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
      .replace(/\s*—\s*/g, ', ')
      .replace(/\.$/, '')
      .trim()
    if (clean === '' || clean.endsWith(':') || clean.length > MAX_KEPT) continue
    if (/^(none|no |nothing|here are|here's|sure)/i.test(clean) || /^[[\]{}]$/.test(clean)) continue
    if (!out.some(o => o.toLowerCase() === clean.toLowerCase())) out.push(clean)
    if (out.length === MAX_ITEMS) break
  }
  return out
}
