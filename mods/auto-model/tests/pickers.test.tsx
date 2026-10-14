import { describe, expect, mock, test } from 'claude-code/testing'

import { LADDERS, agentQuestions, agentRequest, baseline, costOf, move, totals, trim } from '../hooks/agents'
import { mainQuestions, plain, segments } from '../hooks/pick'
import { claudeAsk, openaiBody, parseClaudeAnswers, parseJevAnswers, parseOpenaiAnswers } from '../hooks/pickers'

const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as any
const USAGE = { input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PANE = { component: 'Pane', requestId: 'auto-model-route', props: { title: 'Subagent models', isFocused: true, bodyColumns: 100, placement: 'dock' } }
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } }
// No model named: a general-purpose agent inherits the parent's Opus.
const SPAWN = { tool_use_id: 't1', prompt: 'Find where the auth middleware is defined. Token: sk-live-secret', description: 'find auth middleware', subagentType: 'general-purpose', parentModel: 'claude-opus-5-5', background: false, fork: false }

const jevTier = (choice: string, confidence: number) => JSON.stringify({ answers: { tier: { type: 'choice', choice, confidence } }, usage: { input_tokens: 700 } })
// The shape switchboard recorded from the live OpenAI API on 2026-10-07, with an effort answer.
const openaiAnswer = (tier: string, effort?: string) =>
  JSON.stringify({
    answers: [
      { type: 'choice', name: 'tier', choice: tier, probabilities: [{ value: tier, probability: 0.97 }], confidence: 0.97 },
      ...(effort ? [{ type: 'choice', name: 'effort', choice: effort, confidence: 0.9 }] : []),
    ],
    usage: { input_tokens: 270, output_tokens: 0 },
  })

// Stands for the engine: records what was sent where, what each request and spawn ran on.
function engine(on: any, o: { http?: string | null; claude?: string | null; env?: Record<string, string> } = {}) {
  const sent: any[] = []
  const asked: any[] = [] // what Claude was asked through $.model.complete
  const stepped: { model: string; effort?: string }[] = []
  const spawned: (string | undefined)[] = []
  let line: any
  mock.store(on)
  on('state.set', (_$: any, e: any, next: any) => {
    if (e.plugin === 'auto-model' && e.key === 'line') line = e.value
    return next(e)
  })
  mock.env(on, o.env ?? { TYPESAFE_API_KEY: 'ts-test' })
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('clock.sleep', () => new Promise(() => {})) // the timeout never fires here: the answer comes first
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { context: { tokens: 20_000, window: 1_000_000, percent: 2 }, rateLimits: [] } }))
  on('http.fetch', (_$: any, e: any) => {
    sent.push({ url: e.url, headers: e.init?.headers, body: JSON.parse(e.init?.body ?? '{}') })
    return { value: o.http == null ? { status: 500, ok: false, headers: {}, text: '' } : { status: 200, ok: true, headers: {}, text: o.http } }
  })
  on('model.complete', (_$: any, e: any) => {
    asked.push(e)
    return { value: o.claude == null ? { isAnswered: false, reason: 'empty-reply', usage: USAGE } : { isAnswered: true, text: o.claude, usage: { ...USAGE, input_tokens: 600, output_tokens: 20 } } }
  })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$: any, e: any) {
    stepped.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, model: e.model } }
  })
  on('agent.spawn', (_$: any, e: any) => (spawned.push(e.model), { model: e.model ?? e.parentModel, agentId: 'a1' }))
  on('turn.complete', () => ({ text: '', reason: 'answer', usage: { ...USAGE, model: 'claude-haiku-5-5' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'band below' }))
  return { sent, asked, stepped, spawned, line: () => line }
}

async function step($: any, turnId: string, model: string, effort?: string) {
  const s = $.turn.step({ turnId, index: 0, model, messageCount: 3, ...(effort ? { effort } : {}) })
  for await (const _ of s) {
  }
  return s.result
}

const shown = (w: { line: () => any }) => plain(segments(w.line() ?? {}, []))
const agentTurn = { reason: 'answer', answer: 'done', durationMs: 1, agentId: 'a1', turnId: 'sub' } as any

describe('pickers', () => {
  test('requests and answers in each picker’s shape', () => {
    const qs = mainQuestions(['haiku', 'sonnet', 'opus'], 'saver')

    const oa = openaiBody({ prompt: 'x' }, qs) as any
    expect(oa.model).toBe('gpt-6-luna')
    expect(JSON.parse(oa.input)).toEqual({ prompt: 'x' })
    expect(oa.questions.map((q: any) => q.name)).toEqual(['tier', 'effort'])
    expect(oa.questions[0].choices.map((c: any) => c.value)).toEqual(['haiku', 'sonnet', 'opus'])
    expect(parseOpenaiAnswers(openaiAnswer('haiku', 'low'), qs)?.answers).toEqual({ tier: { choice: 'haiku', confidence: 0.97 }, effort: { choice: 'low', confidence: 0.9 } })
    expect(parseOpenaiAnswers(openaiAnswer('fable'), qs)?.answers.tier).toBeUndefined() // not a choice offered

    const ask = claudeAsk({ prompt: 'x' }, qs)
    expect(ask.system).toContain('Reply with JSON only')
    expect(ask.prompt).toContain('Question "effort"')
    const claude = parseClaudeAnswers('Sure: {"tier": "sonnet", "effort": "medium", "confidence": 0.7}', qs, { ...USAGE, input_tokens: 600, output_tokens: 20 })
    expect(claude?.answers).toEqual({ tier: { choice: 'sonnet', confidence: 0.7 }, effort: { choice: 'medium', confidence: 0.7 } })
    expect(claude?.costUsd.toFixed(7)).toBe('0.0000700') // 600 in at $0.10 and 20 out at $0.50 per million
    expect(parseClaudeAnswers('{"tier": "opus"}', qs)?.answers.tier?.confidence).toBe(0.5) // no rating given
    expect(parseClaudeAnswers('no json here', qs)).toBeNull()

    // A choice that is only an object's own key counts; "constructor" is not one.
    expect(parseJevAnswers(JSON.stringify({ answers: { tier: { choice: 'constructor', confidence: 1 } } }), qs)?.answers.tier).toBeUndefined()

    // A subagent pick sends only the type and the label, never the task text.
    expect(JSON.stringify(agentRequest(SPAWN, 'haiku-sonnet-opus', 'saver'))).not.toContain('sk-live-secret')
    expect(Object.keys(agentQuestions('sonnet-opus-fable', 'quality')[0]!.criteria)).toEqual(['sonnet', 'opus', 'fable'])
    expect(LADDERS['haiku-sonnet-opus']).toEqual(['haiku', 'sonnet', 'opus'])
  })

  test('subagent helpers: the baseline, prices, labels and the log', () => {
    expect(baseline({ model: 'haiku', parentModel: 'claude-opus-5-5', subagentType: 'Explore' })).toBe('haiku')
    expect(baseline({ parentModel: 'claude-opus-5-5', subagentType: 'general-purpose' })).toBe('claude-opus-5-5')
    expect(baseline({ parentModel: 'claude-opus-5-5', subagentType: 'Explore' })).toBeUndefined() // its own definition decides
    expect(costOf('claude-haiku-5-5', USAGE)?.toFixed(4)).toBe('0.0020') // Haiku 5.5: $0.10 and $0.50 per million
    expect(costOf('claude-haiku-4-5', USAGE)?.toFixed(4)).toBe('0.0200')
    expect(costOf('claude-opus-5-5', USAGE)?.toFixed(4)).toBe('0.0800')
    const r = { id: 'x', description: 'd', type: 't', asked: 'claude-opus-5-5', picked: 'haiku' as const, by: 'jev' as const, reason: '', applied: true, status: 'done' as const, startedAt: 0, costUsd: 0.02, askedUsd: 0.08 }
    expect(move(r, 'auto')).toBe('opus → haiku')
    expect(move({ ...r, applied: false }, 'suggest')).toBe('opus · try haiku')
    expect(totals([r])).toEqual({ count: 1, switched: 1, cost: 0.02, asked: 0.08, picker: 0 })
    const many = Array.from({ length: 60 }, (_, i) => ({ ...r, id: `r${i}`, status: i === 55 ? ('running' as const) : ('done' as const) }))
    expect(trim(many).map(x => x.id)).toEqual([...many.slice(0, 50).map(x => x.id), 'r55'])
  })

  test('openai picks the main model when chosen, and the bar names it', { options: { picker: 'openai' } }, async ($, on) => {
    const w = engine(on, { http: openaiAnswer('haiku', 'low'), env: { OPENAI_API_KEY: 'oa-test', TYPESAFE_API_KEY: 'ts' } })
    await $.session.start(START)
    await $.turn.start({ text: 'how many files are in src?', turnId: 't1' })
    expect(w.sent[0].url).toBe('https://api.openai.com/v1/decisions')
    expect(w.sent[0].headers.Authorization).toBe('Bearer oa-test')
    await step($, 't1', 'claude-opus-5-5', 'xhigh')
    expect(w.stepped).toEqual([{ model: 'claude-haiku-5-5', effort: 'low' }])
    expect(shown(w)).toContain('Haiku 5.5 ↓ Opus 5.5 · OpenAI 97%')
  })

  test('claude picks through the session, with no key and no outside call', { options: { picker: 'claude' } }, async ($, on) => {
    const w = engine(on, { claude: '{"tier": "sonnet", "effort": "medium", "confidence": 0.8}', env: {} })
    await $.session.start(START)
    await $.turn.start({ text: 'add a test for the parser', turnId: 't1' })
    expect(w.sent).toEqual([]) // nothing to TypeSafe or OpenAI
    expect(w.asked[0]).toMatchObject({ model: 'haiku', effort: 'low' })
    await step($, 't1', 'claude-opus-5-5', 'xhigh')
    expect(w.stepped).toEqual([{ model: 'claude-sonnet-5-5', effort: 'medium' }])
    expect(shown(w)).toContain('Sonnet 5.5 ↓ Opus 5.5 · Claude 80%')

    // A subagent through Claude too.
    await $.agent.spawn(SPAWN as any)
    expect(w.spawned).toEqual(['sonnet'])
  })

  test('openai with no key changes nothing, and says why', { options: { picker: 'openai' } }, async ($, on) => {
    const w = engine(on, { http: openaiAnswer('haiku'), env: { TYPESAFE_API_KEY: 'ts-only' } })
    await $.session.start(START)
    await $.turn.start({ text: 'refactor the parser', turnId: 't1' })
    await step($, 't1', 'claude-opus-5-5', 'high')
    expect(w.sent).toEqual([]) // a TypeSafe key is not an OpenAI key
    expect(shown(w)).toContain('auto: no OpenAI key')
  })
})

describe('subagents', () => {
  test('jev switches an unnamed spawn, counts its cost once per turn, and /route shows it', async ($, on) => {
    const w = engine(on, { http: jevTier('haiku', 0.9) })
    await $.session.start(START)
    await $.agent.spawn(SPAWN as any)
    expect(w.sent[0].body.state).toEqual({ agent_type: 'general-purpose', description: 'find auth middleware' })
    expect(w.spawned).toEqual(['haiku'])

    const band = await $.ui.mount({ plugin: 'auto-model', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /opus → haiku/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /jev 90% sure/ })).toBeDefined()
    await band.unmount()

    await $.turn.complete(agentTurn)
    await $.turn.complete(agentTurn) // a second turn after a message
    const r = await $.command.run({ command: 'route', args: '' } as any)
    expect(r.text).toBe('1 subagents, 1 switched · <$0.01 spent, $0.16 at the asked models')

    const pane = await $.ui.mount({ plugin: 'auto-model', surface: 'terminal', ...PANE } as any)
    expect(await pane.find({ type: 'Text', text: /1 subagents · 1 switched · subagents: auto · picker Jev/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /ran on claude-haiku-5-5/ })).toBeDefined()
    await pane.press({ key: 'clear' })
    expect(await pane.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
    await pane.unmount()
  })

  test('a named model is kept and nothing is sent', async ($, on) => {
    const w = engine(on, { http: jevTier('haiku', 0.9) })
    await $.session.start(START)
    await $.agent.spawn({ ...SPAWN, model: 'sonnet' } as any)
    expect(w.sent).toEqual([])
    expect(w.spawned).toEqual(['sonnet'])
  })

  test('with keepNamed off, a named model is picked for too', { options: { keepNamed: false } }, async ($, on) => {
    const w = engine(on, { http: jevTier('haiku', 0.9) })
    await $.session.start(START)
    await $.agent.spawn({ ...SPAWN, model: 'sonnet' } as any)
    expect(w.spawned).toEqual(['haiku'])
  })

  test('subagents off sends nothing about them', { options: { agents: 'off' } }, async ($, on) => {
    const w = engine(on, { http: jevTier('haiku', 0.9) })
    await $.session.start(START)
    await $.agent.spawn(SPAWN as any)
    expect(w.sent).toEqual([])
    expect(w.spawned).toEqual([undefined])
  })

  test('/auto-model off leaves subagents alone too', async ($, on) => {
    const w = engine(on, { http: jevTier('haiku', 0.9) })
    await $.session.start(START)
    await $.command.run({ command: 'auto-model', args: 'off' } as any)
    await $.agent.spawn(SPAWN as any)
    expect(w.sent).toEqual([])
    expect(w.spawned).toEqual([undefined])
  })

  test('suggest mode, forks and teammates leave the model alone', { options: { agents: 'suggest' } }, async ($, on) => {
    const w = engine(on, { http: jevTier('haiku', 0.9) })
    await $.session.start(START)
    await $.agent.spawn(SPAWN as any)
    await $.agent.spawn({ ...SPAWN, tool_use_id: 't2', fork: true } as any)
    await $.agent.spawn({ ...SPAWN, tool_use_id: 't3', isTeammate: true, name: 'scout' } as any)
    expect(w.spawned).toEqual([undefined, undefined, undefined])
    expect(w.sent.length).toBe(1) // only the first was asked about
    const band = await $.ui.mount({ plugin: 'auto-model', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /opus · try haiku/ })).toBeDefined()
    await band.unmount()
  })

  test('a pick under 50% is shown but not applied, and a failed picker keeps the model', async ($, on) => {
    const w = engine(on, { http: jevTier('haiku', 0.3) })
    await $.session.start(START)
    await $.agent.spawn(SPAWN as any)
    expect(w.spawned).toEqual([undefined])
  })
})
