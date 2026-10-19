import { describe, expect, mock, test } from 'claude-code/testing'

import { choicesUpTo, decide, jevRequest, label, meterOf, noteSegs, parseJev, plain, redact, segments } from '../hooks/pick'

const USAGE = { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as any
const BASE = { switchDownUntil: 100_000, minConfidence: 0.5 }
const HINT = { component: 'PromptHint', props: { isDraft: false, isWorking: true, hint: 'esc to interrupt' } } as const
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } } as any
const LIMITS = [
  { kind: 'five_hour', percentUsed: 12 },
  { kind: 'seven_day', percentUsed: 54 },
]

// The shape Jev returned live on 2026-10-13 for the two questions.
function jevAnswer(choice: string, confidence: number, effort?: string, effortSure = 0.83) {
  return JSON.stringify({
    model: 'jev-1.13.0',
    answers: {
      tier: { type: 'choice', choice, probabilities: { haiku: 0.82, sonnet: 0.15, opus: 0.03 }, confidence },
      ...(effort ? { effort: { type: 'choice', choice: effort, confidence: effortSure } } : {}),
    },
    usage: { input_tokens: 740 },
  })
}

// Stands for the engine beneath the mod: records what each request named and what Jev was sent.
function engine(on: any, o: { answer?: string | null; contextTokens?: number; env?: Record<string, string>; limits?: any[] } = {}) {
  const sent: any[] = []
  const stepped: { model: string; effort?: string }[] = []
  let line: any // the last value written to the line's state
  mock.store(on)
  on('state.set', (_$: any, e: any, next: any) => {
    if (e.plugin === 'auto-model' && e.key === 'line') line = e.value
    return next(e)
  })
  mock.env(on, o.env ?? { TYPESAFE_API_KEY: 'ts-test' })
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('clock.sleep', () => new Promise(() => {})) // the timeout never fires here: the fetch answers first
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { context: { tokens: o.contextTokens ?? 20_000, window: 1_000_000, percent: Math.round((o.contextTokens ?? 20_000) / 10_000) }, rateLimits: o.limits ?? LIMITS } }))
  on('http.fetch', (_$: any, e: any) => {
    sent.push({ url: e.url, body: JSON.parse(e.init?.body ?? '{}') })
    return { value: o.answer == null ? { status: 500, ok: false, headers: {}, text: '' } : { status: 200, ok: true, headers: {}, text: o.answer } }
  })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$: any, e: any) {
    stepped.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, model: e.model } }
  })
  on('turn.complete', () => ({ text: '', reason: 'answer' }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'esc to interrupt' }))
  return { sent, stepped, line: () => line }
}

// The bar as text, from the state it draws from.
function shown(w: { line: () => any }) {
  const value = w.line()
  return plain(segments(value ?? {}, Object.values(value?.subagents ?? {}).map((s: any) => s.model)))
}

async function step($: any, turnId: string, model: string, o: { agentId?: string; effort?: string } = {}) {
  const s = $.turn.step({ turnId, index: 0, model, messageCount: 3, ...(o.effort ? { effort: o.effort } : {}), ...(o.agentId ? { agentId: o.agentId } : {}) })
  for await (const _ of s) {
  }
  return s.result
}

// What a turn runs on: tier, model rewrite, effort, effort rewrite (null: left as is).
const runsOn = (i: Parameters<typeof decide>[0]) => {
  const d = decide(i)
  return [d.tier, d.rewrite ?? null, d.effort ?? null, d.effortRewrite ?? null]
}

const complete = (turnId: string, agentId?: string) => ({ answer: '', durationMs: 10, isAborted: false, turnId, reason: 'answer', ...(agentId ? { agentId } : {}) }) as any

describe('auto-model', () => {
  test('labels, requests and answers', () => {
    expect(label('claude-opus-5-5')).toBe('Opus 5.5')
    expect(label('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(label('claude-fable-5-1')).toBe('Fable 5.1')
    expect(label('claude-opus-4-20250514')).toBe('Opus 4')
    expect(label('something-else')).toBe('something-else')

    expect(redact('key sk-live-abcdefghijklmnopqrst and AKIAABCDEFGHIJKLMNOP')).toBe('key [redacted] and [redacted]')
    expect(redact('a3f9c2e8b7d6a5f4e3c2b1a0f9e8d7c6b5a4')).toBe('[redacted]')
    expect(redact('build me a weather dashboard')).toBe('build me a weather dashboard')

    expect(choicesUpTo('opus')).toEqual(['haiku', 'sonnet', 'opus'])
    const req = jevRequest('x'.repeat(5_000), choicesUpTo('opus'), { tier: 'opus', effort: 'high' }, 'saver') as any
    expect(req.state.prompt.length).toBe(1_500)
    expect(req.state).toMatchObject({ previous_turn_model: 'opus', previous_turn_effort: 'high' })
    expect(Object.keys(req.questions.tier.criteria)).toEqual(['haiku', 'sonnet', 'opus'])
    expect(Object.keys(req.questions.effort.criteria)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])

    expect(parseJev(jevAnswer('haiku', 0.82, 'low'), ['haiku', 'sonnet', 'opus'])).toMatchObject({ tier: 'haiku', confidence: 0.82, effort: 'low', effortSure: 0.83 })
    expect(parseJev(jevAnswer('haiku', 0.82), ['haiku', 'sonnet', 'opus'])?.effort).toBeUndefined() // effort is optional
    expect(parseJev(jevAnswer('haiku', 0.82, 'turbo'), ['haiku', 'sonnet', 'opus'])?.effort).toBeUndefined()
    expect(parseJev(jevAnswer('fable', 0.9), ['haiku', 'sonnet', 'opus'])).toBeNull() // above the ceiling
    expect(parseJev('nope', ['haiku'])).toBeNull()

    expect(meterOf({ context: { percent: 9 }, rateLimits: LIMITS })).toEqual({ ctx: 9, sevenDay: 54 })
    expect(meterOf({ context: {}, rateLimits: [] })).toEqual({}) // off a subscription: no 7-day window
  })

  test('decisions: model and effort, never above /model and /effort, held with a large context', () => {
    const pick = { tier: 'haiku' as const, confidence: 0.82, effort: 'low' as const, effortSure: 0.83, costUsd: 0 }
    const base = { ...BASE, base: 'claude-opus-5-5', baseEffort: 'xhigh' }
    expect(decide({ ...base, pick })).toMatchObject({ note: { kind: 'switched', from: 'claude-opus-5-5', sure: 0.82 }, effortNote: 'auto' })
    expect(runsOn({ ...base, pick })).toEqual(['haiku', 'claude-haiku-5-5', 'low', 'low'])
    expect(runsOn({ ...base, pick: { ...pick, confidence: 0.4, effortSure: 0.4 } })).toEqual(['opus', null, 'xhigh', null]) // too unsure: both kept
    expect(runsOn({ ...base, pick: { ...pick, confidence: 0.4 } })).toEqual(['opus', null, 'low', 'low']) // each answer on its own confidence
    expect(runsOn({ ...base, base: 'claude-sonnet-5-5', baseEffort: 'high', pick: { ...pick, tier: 'opus', effort: 'max' } })).toEqual(['sonnet', null, 'high', null]) // never above
    expect(runsOn({ ...base, baseEffort: undefined, pick })).toEqual(['haiku', 'claude-haiku-5-5', null, null]) // a model without effort
    expect(decide({ ...base, pick: null, noPick: 'Jev did not answer' })).toMatchObject({ note: { kind: 'none', reason: 'Jev did not answer' }, effort: 'xhigh', effortNote: 'kept' })

    // Large context: no moving down from where the last turn was, in model or effort...
    const big = { ...base, contextTokens: 300_000 }
    expect(runsOn({ ...big, previous: 'claude-opus-5-5', previousEffort: 'xhigh', pick })).toEqual(['opus', null, 'xhigh', null])
    expect(decide({ ...big, previous: 'claude-opus-5-5', previousEffort: 'xhigh', pick })).toMatchObject({ note: { kind: 'held' }, effortNote: 'held' })
    expect(runsOn({ ...big, previous: 'claude-sonnet-5-5', previousEffort: 'medium', pick })).toEqual(['sonnet', 'claude-sonnet-5-5', 'medium', 'medium'])
    // ...but moving up is fine, and once the model moves the cache is gone, so the effort follows the pick.
    expect(runsOn({ ...big, previous: 'claude-haiku-5-5', previousEffort: 'low', pick: { ...pick, tier: 'opus', effort: 'high' } })).toEqual(['opus', null, 'high', 'high'])
    expect(runsOn({ ...big, switchDownUntil: Infinity, previous: 'claude-opus-5-5', pick })).toEqual(['haiku', 'claude-haiku-5-5', 'low', 'low'])
  })

  test('the bar: model │ effort │ ctx │ 7d │ agents, each value in its color', () => {
    const main = { model: 'claude-haiku-5-5', note: { kind: 'switched', from: 'claude-opus-5-5', sure: 0.82 }, phase: 'running', effort: 'low', effortNote: 'auto' } as const
    const segs = segments({ main, meter: { ctx: 9, sevenDay: 54 } }, ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
    expect(plain(segs)).toBe('◆ Haiku 5.5 ↓ Opus 5.5 · Jev 82%  │  effort low ↓  │  ctx ▰▱▱▱▱▱▱▱▱▱ 9%  │  7d 54%  │  ◆ 3 agents  ● Sonnet 5.5 ×2  ● Haiku 5.5')
    expect(segs[0]).toEqual({ text: '◆ ', color: '#34d399' })
    expect(segs.find(s => s.text === 'Haiku 5.5')).toEqual({ text: 'Haiku 5.5', bold: true })
    expect(segs.find(s => s.text === 'Opus 5.5')).toMatchObject({ dim: true, strike: true })
    expect(segs.find(s => s.text === 'low')?.color).toBe('#34d399')
    expect(segs.find(s => s.text === '▰')?.color).toBe('success')
    expect(segs.find(s => s.text === '54%')?.color).toBe('warning')
    expect(segs.find(s => s.text.includes('Sonnet 5.5 ×2'))?.color).toBe('#60a5fa')

    expect(plain(segments({ main: { ...main, model: 'claude-opus-5-5', note: { kind: 'held', sure: 0.9, wanted: 'claude-haiku-5-5', tokens: 300_000 }, effort: 'xhigh', effortNote: 'held' }, meter: { ctx: 85 } }, []))).toBe(
      '◆ Opus 5.5 ⏸ held, wanted Haiku 5.5 · Jev 90%  │  effort xhigh ⏸  │  ctx ▰▰▰▰▰▰▰▰▰▱ 85%  │  ◇ 0 agents',
    )
    expect(noteSegs({ kind: 'unsure', sure: 0.34 }).find(s => s.text === 'Jev 34%')?.color).toBe('error')
    expect(noteSegs({ kind: 'none', reason: 'no TypeSafe key' })[0]?.color).toBe('warning')
    expect(noteSegs({ kind: 'none', reason: 'no prompt to judge' })[0]?.dim).toBe(true)
  })

  test('a quick question runs on Haiku at low effort, and the bar says so', async ($, on) => {
    const w = engine(on, { answer: jevAnswer('haiku', 0.82, 'low') })
    await $.session.start(START)
    expect(shown(w)).toBe('◆ Opus 5.5 · auto  │  ctx ▰▱▱▱▱▱▱▱▱▱ 2%  │  7d 54%  │  ◇ 0 agents')
    await $.turn.start({ text: 'How many unread emails are in my Gmail right now? token sk-live-abcdefghijklmnopqrst', turnId: 't1' })
    expect(w.sent[0].url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(JSON.stringify(w.sent[0].body)).not.toContain('sk-live')
    await step($, 't1', 'claude-opus-5-5', { effort: 'xhigh' })
    expect(w.stepped).toEqual([{ model: 'claude-haiku-5-5', effort: 'low' }])
    expect(shown(w)).toBe('◆ Haiku 5.5 ↓ Opus 5.5 · Jev 82%  │  effort low ↓  │  ctx ▰▱▱▱▱▱▱▱▱▱ 2%  │  7d 54%  │  ◇ 0 agents')
    // A subagent shows beside it, on its own model and effort, unchanged.
    await step($, 't1', 'claude-sonnet-5-5', { agentId: 'a1', effort: 'high' })
    expect(w.stepped[1]).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' })
    expect(shown(w)).toContain('│  ◆ 1 agent  ● Sonnet 5.5')

    // On the terminal: under the prompt, above the engine's hint.
    const term = await $.ui.mount({ plugin: 'auto-model', surface: 'terminal', ...HINT })
    expect(await term.find({ type: 'Text', text: /esc to interrupt/ })).toBeDefined()
    expect(await term.find({ type: 'Text', text: /Haiku 5\.5/ })).toBeDefined()
    await term.unmount()
    const termBand = await $.ui.mount({ plugin: 'auto-model', surface: 'terminal', ...BAND })
    expect(await termBand.find({ type: 'Text', text: /Haiku 5\.5/ })).toBeUndefined()
    await termBand.unmount()
    // On the desktop, which draws no hint line: the hint is left alone and the bar sits above the prompt.
    const hint = await $.ui.mount({ plugin: 'auto-model', surface: 'desktop', ...HINT })
    expect(await hint.find({ type: 'Text', text: /Haiku 5\.5/ })).toBeUndefined()
    await hint.unmount()
    const band = await $.ui.mount({ plugin: 'auto-model', surface: 'desktop', ...BAND })
    expect(await band.find({ type: 'Text', text: /Haiku 5\.5/ })).toBeDefined()
    await band.unmount()

    await $.turn.complete(complete('t1', 'a1'))
    await $.turn.complete(complete('t1'))
    expect(shown(w)).toContain('◇ 0 agents')

    // The next turn sends Jev what the last one ran on.
    await $.turn.start({ text: 'yes, go ahead', turnId: 't2' })
    expect(w.sent[1].body.state).toMatchObject({ previous_turn_model: 'haiku', previous_turn_effort: 'low' })
  })

  test('a large context holds the model and effort instead of moving down', async ($, on) => {
    const w = engine(on, { answer: jevAnswer('haiku', 0.9, 'low'), contextTokens: 300_000 })
    await $.session.start(START)
    await $.turn.start({ text: 'what time is it in Tokyo?', turnId: 't1' })
    await step($, 't1', 'claude-opus-5-5', { effort: 'xhigh' })
    expect(w.stepped).toEqual([{ model: 'claude-opus-5-5', effort: 'xhigh' }])
    expect(shown(w)).toContain('◆ Opus 5.5 ⏸ held, wanted Haiku 5.5 · Jev 90%  │  effort xhigh ⏸')
  })

  test('off, no key or no answer: nothing changes, and the bar says why', async ($, on) => {
    const w = engine(on, { answer: null, env: {}, limits: [] })
    await $.session.start(START)
    await $.turn.start({ text: 'build me a weather dashboard', turnId: 't1' })
    await step($, 't1', 'claude-opus-5-5', { effort: 'high' })
    expect(w.sent).toEqual([]) // no key, nothing sent
    expect(shown(w)).toBe('◆ Opus 5.5 · auto: no TypeSafe key  │  effort high  │  ctx ▰▱▱▱▱▱▱▱▱▱ 2%  │  ◇ 0 agents')

    await $.command.run({ command: 'auto-model', args: 'off' } as any)
    await $.turn.complete(complete('t1'))
    await $.turn.start({ text: 'anything', turnId: 't2' })
    await step($, 't2', 'claude-opus-5-5', { effort: 'high' })
    expect(w.stepped).toEqual([
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-5-5', effort: 'high' },
    ])
    expect(shown(w)).toContain('◆ Opus 5.5 · auto off  │  effort high  │')
  })

  test('Jev failing keeps the model and effort', async ($, on) => {
    const w = engine(on, { answer: null })
    await $.session.start(START)
    await $.turn.start({ text: 'refactor the auth module', turnId: 't1' })
    await step($, 't1', 'claude-opus-5-5', { effort: 'xhigh' })
    expect(w.sent.length).toBe(1)
    expect(w.stepped).toEqual([{ model: 'claude-opus-5-5', effort: 'xhigh' }])
    expect(shown(w)).toContain('◆ Opus 5.5 · auto: Jev did not answer  │  effort xhigh  │')
  })
})
