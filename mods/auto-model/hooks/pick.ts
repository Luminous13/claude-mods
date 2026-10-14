// The deciding half, kept free of the engine so tests call it directly: what goes to Jev,
// how its answer is read, which model and effort a turn runs on, and the line under the prompt.
import type { Effort, EffortNote, Main, Meter, Note, Picker, Tier } from '../types'
import { PICKER_LABEL, jevBody, parseJevAnswers } from './pickers'
import type { Answered, Question } from './pickers'

export { JEV_URL } from './pickers'

export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable']
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const MODEL_ID: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
}
const PROMPT_CHARS = 1_500 // what a picker reads of a prompt at most

export type Style = 'saver' | 'quality'
const FOLLOW_UP =
  'A short follow-up that approves or continues earlier work ("yes", "go ahead", "do it", "continue", "fix that") continues that work: pick previous_turn_model and previous_turn_effort for it.'
const QUESTION: Record<Style, string> = {
  saver: `A developer sent this prompt to their coding agent. Which is the cheapest model that will still do this turn well? ${FOLLOW_UP}`,
  quality: `A developer sent this prompt to their coding agent. They pay for quality on anything they will rely on and use a cheaper model only for quick lookups and routine chores. Which model fits this turn? ${FOLLOW_UP}`,
}
const EFFORT_QUESTION: Record<Style, string> = {
  saver: `How much should the model think on this turn? Pick the lowest effort that will still do it well. ${FOLLOW_UP}`,
  quality: `How much should the model think on this turn? Think harder on anything the developer will rely on; keep it low only for quick lookups and chores. ${FOLLOW_UP}`,
}
const DESCRIBE: Record<Tier, string> = {
  haiku: 'Quick questions and lookups: a fact, a count, a status check, reading or summarizing something short, a one-line change, a rename, one simple shell command.',
  sonnet: 'Everyday coding and writing: implementing a planned change, fixing an ordinary bug, writing tests, editing a few files, drafting a message or a doc.',
  opus: 'Hard or high-stakes work: planning, architecture, debugging something subtle, reviews and audits, building something new end to end, anything where a wrong answer is costly.',
  fable: 'The hardest few: long autonomous work, research-grade problems, or decisions where even Opus is likely to fall short. Costs 2.5x Opus.',
}
const DESCRIBE_EFFORT: Record<Effort, string> = {
  low: 'Answer straight away: a fact, a count, a lookup, a one-line edit, one simple command. Little or no thinking.',
  medium: 'Some thought: ordinary coding, a small feature, a bug with a clear cause, a short document.',
  high: 'Careful thought: multi-step work, unfamiliar code, a tricky bug, a review that has to catch problems.',
  xhigh: 'Deep thought: planning or architecture, a subtle or intermittent bug, a large refactor, a high-stakes decision.',
  max: 'The hardest problems, where getting it right matters far more than time or cost.',
}

export function tierOf(model: string | undefined): Tier | undefined {
  if (!model) return undefined
  const m = model.toLowerCase()
  return TIERS.find(t => m.includes(t))
}

export function effortOf(v: unknown): Effort | undefined {
  return EFFORTS.find(x => x === v)
}

const rank = (t: Tier) => TIERS.indexOf(t)
const rankE = (x: Effort) => EFFORTS.indexOf(x)

// "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5"; anything else as given.
export function label(model: string | undefined): string {
  if (!model) return '?'
  const m = /(haiku|sonnet|opus|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(model)
  if (!m?.[1]) return model
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`
}

// Keys, tokens and other long secrets are cut from a prompt before it leaves the machine.
export function redact(text: string): string {
  return text
    .replace(/\b(sk-[\w-]{16,}|ghp_\w{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[\w-]{10,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g, '[redacted]')
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, s => (/\d/.test(s) && /[A-Za-z]/.test(s) ? '[redacted]' : s))
}

// The models Jev may choose between: every tier up to the one /model set.
export function choicesUpTo(ceiling: Tier): Tier[] {
  return TIERS.filter(t => rank(t) <= rank(ceiling))
}

// What a picker reads for a prompt: the prompt (secrets cut, its first 1,500 characters) and
// what the last turn ran on.
export function mainState(text: string, previous: { tier?: Tier; effort?: Effort }) {
  return { prompt: redact(text).slice(0, PROMPT_CHARS), previous_turn_model: previous.tier ?? null, previous_turn_effort: previous.effort ?? null }
}

// Two questions: the model, and the effort (clamped to /effort's when the turn starts).
export function mainQuestions(choices: readonly Tier[], style: Style): Question[] {
  return [
    { name: 'tier', instructions: QUESTION[style], criteria: Object.fromEntries(choices.map(t => [t, DESCRIBE[t]])) },
    { name: 'effort', instructions: EFFORT_QUESTION[style], criteria: DESCRIBE_EFFORT },
  ]
}

// The questions in Jev's shape.
export function jevRequest(text: string, choices: readonly Tier[], previous: { tier?: Tier; effort?: Effort }, style: Style) {
  return jevBody(mainState(text, previous), mainQuestions(choices, style))
}

export type Pick = { tier: Tier; confidence: number; effort?: Effort; effortSure?: number; costUsd: number }

// Any picker's answers as a pick, or null without a model it may choose. Effort is optional.
export function mainPickOf(a: Answered | null, choices: readonly Tier[]): Pick | null {
  const t = a?.answers.tier
  if (!a || !t || !choices.includes(t.choice as Tier)) return null
  const e = a.answers.effort
  const effort = effortOf(e?.choice)
  return { tier: t.choice as Tier, confidence: t.confidence, ...(effort && e ? { effort, effortSure: e.confidence } : {}), costUsd: a.costUsd }
}

// Jev's answer, or null when it is not one we can use.
export function parseJev(text: string, choices: readonly Tier[]): Pick | null {
  return mainPickOf(parseJevAnswers(text, mainQuestions(choices, 'saver')), choices)
}

export type Decision = {
  tier?: Tier // what the turn runs on; undefined for a model we don't know
  rewrite?: string // the model id each request of the turn names instead; undefined leaves it
  base: string // the model /model set, which a pick never goes above
  pick?: Pick
  note: Note // what the line says about the model
  effort?: Effort // what the turn thinks at; undefined where the model takes no effort
  effortRewrite?: Effort // what each request asks for instead; undefined leaves it
  effortNote?: EffortNote
}

export type DecideInput = {
  base: string
  baseEffort?: unknown // the step's effort as the engine resolved it: /effort's, or the model's default
  previous?: string // what the last main turn ran on
  previousEffort?: string
  pick: Pick | null
  noPick?: string // why there is no pick
  contextTokens?: number
  switchDownUntil: number // context tokens; Infinity for always
  minConfidence: number
  by?: Picker // who picked, for the line
}

export function decide(i: DecideInput): Decision {
  const ceiling = tierOf(i.base)
  if (!ceiling) return { base: i.base, note: { kind: 'none', reason: 'a model it does not know' }, ...effortAsIs(i) }
  if (!i.pick) return { tier: ceiling, base: i.base, note: { kind: 'none', reason: i.noPick ?? 'no pick' }, ...effortAsIs(i) }
  const sure = i.pick.confidence
  const big = (i.contextTokens ?? 0) > i.switchDownUntil
  // Moving down re-reads the whole conversation without the cache: past the limit, stay put.
  const prev = tierOf(i.previous) ?? ceiling
  const heldAt = rank(prev) <= rank(ceiling) ? prev : ceiling
  let tier = ceiling
  const by = i.by ? { by: i.by } : {}
  let note: Note = { kind: 'unsure', sure, ...by }
  if (sure >= i.minConfidence) {
    const wanted = rank(i.pick.tier) > rank(ceiling) ? ceiling : i.pick.tier
    const isHeld = rank(wanted) < rank(heldAt) && big
    tier = isHeld ? heldAt : wanted
    note = isHeld ? { kind: 'held', sure, wanted: MODEL_ID[wanted], tokens: i.contextTokens ?? 0, ...by } : tier !== ceiling ? { kind: 'switched', from: i.base, sure, ...by } : { kind: 'kept', sure, ...by }
  }
  const rewrite = tier === ceiling ? undefined : MODEL_ID[tier]

  // Effort the same way: /effort is the ceiling, and a change drops the cache too, so with a
  // large context it is held where the last turn left it, unless the model changes anyway.
  const top = effortOf(i.baseEffort)
  if (!top) return { tier, rewrite, base: i.base, pick: i.pick, note }
  const asked = i.pick.effort && (i.pick.effortSure ?? 0) >= i.minConfidence ? i.pick.effort : top
  const wantedE = rankE(asked) > rankE(top) ? top : asked
  const prevE = effortOf(i.previousEffort) ?? top
  const heldE = rankE(prevE) <= rankE(top) ? prevE : top
  const modelMoves = tier !== prev
  const effortHeld = !modelMoves && rankE(wantedE) < rankE(heldE) && big
  const effort = effortHeld ? heldE : wantedE
  const effortNote: EffortNote = effortHeld ? 'held' : effort !== top ? 'auto' : 'kept'
  return { tier, rewrite, base: i.base, pick: i.pick, note, effort, effortRewrite: effort === top ? undefined : effort, effortNote }
}

function effortAsIs(i: DecideInput): { effort?: Effort; effortNote?: EffortNote } {
  const e = effortOf(i.baseEffort)
  return e ? { effort: e, effortNote: 'kept' } : {}
}

export function limitOf(setting: unknown): number {
  return setting === 'always' ? Infinity : setting === '250k' ? 250_000 : 100_000
}

// The figures beside the model, from `$.session.usage()`; the 7-day window exists only on a subscription.
export function meterOf(u: { context?: { percent?: number }; rateLimits?: readonly { kind: string; percentUsed: number }[] } | undefined): Meter | undefined {
  if (!u) return undefined
  const sevenDay = u.rateLimits?.find(r => r.kind === 'seven_day')?.percentUsed
  return {
    ...(u.context?.percent !== undefined ? { ctx: u.context.percent } : {}),
    ...(sevenDay !== undefined ? { sevenDay } : {}),
  }
}

// One run of text on the line, styled. Colors are theme keys (light and dark alike) or hex.
export type Seg = { text: string; color?: string; bg?: string; bold?: boolean; dim?: boolean; strike?: boolean }

export const TIER_COLOR: Record<Tier, string> = { haiku: '#34d399', sonnet: '#60a5fa', opus: 'claude', fable: '#c084fc' }
export const EFFORT_COLOR: Record<Effort, string> = { low: '#34d399', medium: '#60a5fa', high: '#fbbf24', xhigh: 'claude', max: '#f87171' }
export function colorOf(model: string | undefined): string {
  const t = tierOf(model)
  return t ? TIER_COLOR[t] : 'inactive'
}

const pct = (n: number) => `${Math.round(n * 100)}%`
const level = (percent: number) => (percent < 50 ? 'success' : percent < 80 ? 'warning' : 'error')
const sureSeg = (sure: number, by?: Picker): Seg => ({ text: `${PICKER_LABEL[by ?? 'jev']} ${pct(sure)}`, color: sure >= 0.8 ? 'success' : sure >= 0.5 ? 'warning' : 'error' })
const dot: Seg = { text: ' · ', dim: true }
const SEP: Seg = { text: '  │  ', dim: true }
const TROUBLE = /key|answer/

// What auto-model did with the model, after its name.
export function noteSegs(n: Note): Seg[] {
  switch (n.kind) {
    case 'on':
      return [{ text: ' · auto', color: 'success' }]
    case 'off':
      return [{ text: ' · auto off', dim: true }]
    case 'asking':
      return [{ text: ` ⟳ ${PICKER_LABEL[n.by ?? 'jev']}…`, color: 'warning', bold: true }]
    case 'switched':
      return [{ text: ' ↓ ', color: 'success', bold: true }, { text: label(n.from), dim: true, strike: true }, dot, sureSeg(n.sure, n.by)]
    case 'kept':
      return [{ text: ' ✓ ', color: 'success', bold: true }, sureSeg(n.sure, n.by)]
    case 'unsure':
      return [{ text: ' ? ', color: 'warning', bold: true }, sureSeg(n.sure, n.by), { text: ' unsure', dim: true }]
    case 'held':
      return [{ text: ' ⏸ ', color: 'warning', bold: true }, { text: 'held, wanted ', dim: true }, { text: label(n.wanted), color: colorOf(n.wanted) }, dot, sureSeg(n.sure, n.by)]
    case 'none':
      return [{ text: ` · auto: ${n.reason}`, ...(TROUBLE.test(n.reason) ? { color: 'warning' } : { dim: true }) }]
  }
}

// Ten cells, the filled ones in the meter's color.
function bar(percent: number): Seg[] {
  const filled = Math.max(percent > 0 ? 1 : 0, Math.min(10, Math.round(percent / 10)))
  return [
    { text: '▰'.repeat(filled), color: level(percent) },
    { text: '▱'.repeat(10 - filled), dim: true },
  ]
}

function agentSegs(subagents: readonly string[]): Seg[] {
  if (subagents.length === 0) return [{ text: '◇ 0 agents', dim: true }]
  const out: Seg[] = [{ text: '◆ ', color: 'warning' }, { text: `${subagents.length} agent${subagents.length > 1 ? 's' : ''}` }]
  const counts = new Map<string, { model: string; n: number }>()
  for (const m of subagents) counts.set(label(m), { model: m, n: (counts.get(label(m))?.n ?? 0) + 1 })
  for (const [l, { model, n }] of counts) out.push({ text: `  ● ${l}${n > 1 ? ` ×${n}` : ''}`, color: colorOf(model) })
  return out
}

// The bar under the prompt: model and what auto did │ effort │ ctx │ 7d │ agents.
export function segments(line: { main?: Main; meter?: Meter }, subagents: readonly string[]): Seg[] {
  const { main, meter } = line
  const parts: Seg[][] = []
  parts.push(main ? [{ text: '◆ ', color: colorOf(main.model) }, { text: label(main.model), bold: true }, ...noteSegs(main.note)] : [{ text: '◇ auto-model', dim: true }])
  const effort = effortOf(main?.effort)
  if (effort) {
    const mark: Seg[] = main?.effortNote === 'auto' ? [{ text: ' ↓', color: 'success', bold: true }] : main?.effortNote === 'held' ? [{ text: ' ⏸', color: 'warning', bold: true }] : []
    parts.push([{ text: 'effort ' }, { text: effort, color: EFFORT_COLOR[effort], bold: true }, ...mark])
  }
  if (meter?.ctx !== undefined) parts.push([{ text: 'ctx ' }, ...bar(meter.ctx), { text: ` ${Math.round(meter.ctx)}%`, color: level(meter.ctx), bold: true }])
  if (meter?.sevenDay !== undefined) parts.push([{ text: '7d ' }, { text: `${Math.round(meter.sevenDay)}%`, color: level(meter.sevenDay), bold: true }])
  parts.push(agentSegs(subagents))
  return parts.flatMap((p, i) => (i === 0 ? p : [SEP, ...p]))
}

export const plain = (segs: readonly Seg[]) => segs.map(s => s.text).join('')

export function usd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}
