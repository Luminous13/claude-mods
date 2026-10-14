// The subagent half, kept free of the engine so tests call it directly: which model a
// subagent should run on, what Jev is sent to decide it, and what each run cost.
// Ported from Hamza Zafar's switchboard 0.3.1 (MIT, see NOTICE.md), with Jev as the only picker.
import type { Route, Tier, Usage } from '../types'
import { tierOf } from './pick'
import type { Style } from './pick'
import { jevBody, parseJevAnswers } from './pickers'
import type { Answered, Question } from './pickers'

// The models Jev may choose between for a subagent, cheapest first. A ladder is a setting.
export type Ladder = 'haiku-sonnet-opus' | 'sonnet-opus-fable'
export const LADDERS: Record<Ladder, readonly Tier[]> = {
  'haiku-sonnet-opus': ['haiku', 'sonnet', 'opus'],
  'sonnet-opus-fable': ['sonnet', 'opus', 'fable'],
}

const QUESTION: Record<Style, string> = {
  saver: 'A coding agent is about to hand this task to a subagent. Which model is the cheapest one that will still do the task well?',
  quality: 'Which model would this developer pick for this subagent? They pay for quality on anything they will rely on, and use the cheaper model for routine execution.',
}
const DESCRIBE: Record<Style, Record<Ladder, Partial<Record<Tier, string>>>> = {
  saver: {
    'haiku-sonnet-opus': {
      haiku: 'Lookups and light work: searching or listing files, reading and summarizing code or docs, answering a factual question about the repo, small mechanical edits.',
      sonnet: 'Everyday coding: implementing a feature, fixing an ordinary bug, writing or updating tests, reviewing a diff, editing a few files.',
      opus: 'Hard thinking: planning or architecture, debugging a subtle or intermittent issue, security review, large multi-file refactors, work where a wrong answer is costly.',
    },
    'sonnet-opus-fable': {
      sonnet: 'Everything routine: lookups, reading, summarizing, research, ordinary coding, tests, reviews and verification of ordinary diffs, docs, small refactors, ordinary bug fixes.',
      opus: 'Hard thinking: planning and architecture, subtle or intermittent bugs, security reviews, large multi-file refactors, work where a wrong answer is costly.',
      fable: 'The hardest few: long-horizon autonomous work running for hours, novel research-grade problems, or the highest-stakes calls where even Opus is likely to fall short. Costs 2.5x Opus, so only when clearly needed.',
    },
  },
  quality: {
    'haiku-sonnet-opus': {
      haiku: 'Only trivial lookups: listing or finding files, reading one file, a quick factual check.',
      sonnet: 'Routine execution: implementing or fixing something whose plan is already decided, routine ops and maintenance, searches and summaries, the standard pre-merge review of a pull request, and verifying that review fixes were applied.',
      opus: 'Anything the developer will rely on: audits and quality checks of finished work, independent or fresh-eyes reviews, extra code reviews and regression hunts, planning, design and idea generation, building a new feature end to end on its own, and high-stakes or security-sensitive work.',
    },
    'sonnet-opus-fable': {
      sonnet: 'Routine execution: implementing or fixing something whose plan is already decided, routine ops and maintenance (servers, disk, configs, sweeps, CI chores), lookups, searches and summaries, the standard pre-merge review of a pull request, and verifying that review fixes were applied.',
      opus: 'Anything the developer will rely on: audits and quality checks of finished work (papers, docs, figures, numbers, references), independent or fresh-eyes reviews, code reviews and regression hunts asked for on top of the standard one, planning, design and idea generation, building a new feature end to end on its own, and high-stakes or security-sensitive work.',
      fable: 'Rare: long autonomous runs left alone for hours, or research-grade problems where even Opus is likely to fall short.',
    },
  },
}

// API prices in USD per million tokens. Estimates, not plan charges.
export const PRICES_AS_OF = '2026-10-06'
const PRICES: { match: RegExp; input: number; output: number; cacheRead: number }[] = [
  { match: /haiku-5/i, input: 0.1, output: 0.5, cacheRead: 0.01 },
  { match: /haiku/i, input: 1, output: 5, cacheRead: 0.1 },
  { match: /sonnet/i, input: 2, output: 10, cacheRead: 0.2 },
  { match: /opus/i, input: 4, output: 20, cacheRead: 0.2 },
  { match: /fable|mythos/i, input: 10, output: 50, cacheRead: 0.25 },
]
// Only the agent type and its short label go out: never the task text, which can hold code,
// paths, hostnames or a pasted key.
type Task = { subagentType: string; description: string }

export function agentState(task: Task) {
  return { agent_type: task.subagentType, description: task.description }
}

// One question: which model on the ladder.
export function agentQuestions(ladder: Ladder, style: Style): Question[] {
  const describe = DESCRIBE[style][ladder]
  return [{ name: 'tier', instructions: QUESTION[style], criteria: Object.fromEntries(LADDERS[ladder].map(t => [t, describe[t] ?? t])) }]
}

// The question in Jev's shape.
export function agentRequest(task: Task, ladder: Ladder, style: Style) {
  return jevBody(agentState(task), agentQuestions(ladder, style))
}

export type AgentAnswer = { tier: Tier; confidence: number; costUsd: number }

// Any picker's answer as a model on the ladder, or null.
export function agentPickOf(a: Answered | null, tiers: readonly Tier[]): AgentAnswer | null {
  const t = a?.answers.tier
  if (!a || !t || !tiers.includes(t.choice as Tier)) return null
  return { tier: t.choice as Tier, confidence: t.confidence, costUsd: a.costUsd }
}

// Jev's answer, or null when it is not one we can use.
export function parseAgentPick(text: string, tiers: readonly Tier[]): AgentAnswer | null {
  return agentPickOf(parseJevAnswers(text, [{ name: 'tier', instructions: '', criteria: Object.fromEntries(tiers.map(t => [t, t])) }]), tiers)
}

// The model the spawn would run on without us, when we can know it: what the caller named,
// or the parent's for an agent that inherits. Undefined when the agent's own definition
// decides, which a hook can't see; such a spawn gets a suggestion, never a switch.
export function baseline(e: { model?: string; parentModel: string; subagentType: string }): string | undefined {
  if (e.model && e.model !== 'inherit') return e.model
  if (e.model === 'inherit' || e.subagentType === 'general-purpose') return e.parentModel
  return undefined
}

// What a run cost at API prices; undefined for a model we have no price for.
export function costOf(model: string, u: Usage): number | undefined {
  const p = PRICES.find(x => x.match.test(model))
  if (!p) return undefined
  const write = p.input * 1.25 // 5-minute cache writes
  return (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_read_input_tokens * p.cacheRead + u.cache_creation_input_tokens * write) / 1_000_000
}

export function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return { ...b }
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  }
}

// The newest 50, but never a running one: its cost and status are still to come.
export function trim(list: Route[]) {
  return list.filter((r, i) => i < 50 || r.status === 'running')
}

// Running, or finished in the last 30 s.
export function isShown(r: Route, at = Date.now()) {
  return r.status === 'running' || (r.endedAt !== undefined && at - r.endedAt < 30_000)
}

// "opus → sonnet", "sonnet (kept)", "opus · try sonnet" in suggest mode, or, with no pick, the
// model it runs on.
export function move(r: Route, mode: 'auto' | 'suggest') {
  const from = r.asked === undefined ? 'own model' : (tierOf(r.asked) ?? r.asked)
  if (!r.picked) return from
  if (r.asked === undefined) return `own model · try ${r.picked}`
  if (r.applied) return `${from} → ${r.picked}`
  if (tierOf(r.asked) === r.picked) return `${r.picked} (kept)`
  return mode === 'suggest' ? `${from} · try ${r.picked}` : `${from} (kept)`
}

export function totals(list: Route[]) {
  const sum = (f: (r: Route) => number | undefined) => list.reduce((n, r) => n + (f(r) ?? 0), 0)
  return {
    count: list.length,
    switched: list.filter(r => r.applied).length,
    cost: sum(r => r.costUsd) + sum(r => r.pickerUsd),
    asked: sum(r => r.askedUsd),
    picker: sum(r => r.pickerUsd),
  }
}

// A cost, or "?" while it is not known yet.
export function usdOrUnknown(n: number | undefined): string {
  if (n === undefined) return '?'
  if (n === 0) return '$0'
  if (n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}
