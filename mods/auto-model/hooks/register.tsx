// Auto model: a picker (Jev by default, or OpenAI, or Claude) picks the main model for each prompt, and a colored line under the input (above it in Desktop)
// says which model each call actually runs on, subagents included.
//   As a turn starts, Jev reads the prompt (secrets cut, its first 1,500 characters) and picks
//   Haiku, Sonnet or Opus and an effort, never above what /model and /effort set. Every request
//   of the turn then names them. Moving down with a large context keeps the last turn's model
//   and effort, since a change re-reads the conversation without the cache. With no key, no answer in 3 s or
//   a pick under 50% sure, nothing changes. /auto-model on|off, and /auto-model alone for what it did.
//   Subagents too: before one starts that names no model, the picker chooses from a ladder by its type and
//   short label alone (never the task text). /route lists every subagent, its pick and its cost.
//   That half is ported from Hamza Zafar's switchboard 0.3.1 (MIT, see NOTICE.md).
import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, Register, TextProps } from 'claude-code'

import type { Line, Note, Route, Stats, Tier } from '../types'
import { LADDERS, PRICES_AS_OF, addUsage, agentPickOf, agentQuestions, agentState, baseline, costOf, isShown, move, totals, trim, usdOrUnknown } from './agents'
import type { Ladder } from './agents'
import { choicesUpTo, decide, effortOf, label, limitOf, mainPickOf, mainQuestions, mainState, meterOf, segments, tierOf, usd } from './pick'
import type { Decision, Pick, Seg, Style } from './pick'
import { CLAUDE_PICK_MODEL, JEV_URL, OPENAI_URL, PICKER_LABEL, claudeAsk, jevBody, openaiBody, parseClaudeAnswers, parseJevAnswers, parseOpenaiAnswers, pickerOf } from './pickers'
import type { Answered, PickerName, Question } from './pickers'

const PICK_TIMEOUT_MS = 3_000 // the turn waits this long for Jev at most
const MIN_CONFIDENCE = 0.5 // below this, a pick is shown but not applied
const SUBAGENT_STALE_MS = 15 * 60_000 // a subagent silent this long leaves the line
const ENABLED = 'enabled' // in $.store, so off stays off across sessions
const AGENT_PICK_TIMEOUT_MS = 4_000 // a spawn waits this long for the picker at most
const CLAUDE_PICK_TIMEOUT_MS = 5_000 // Claude answers through a full model call, so it gets longer
const ROUTE_PANE = 'auto-model-route'
const BAND_ROWS = 3
const PANE_ROWS = 12

// Held by the host, so a hot reload keeps them; the line redraws when `line` is written.
const stats = atom({ plugin: 'auto-model', key: 'stats' } as const, { turns: {}, switched: 0, jevUsd: 0 } as Stats)
const line = atom({ plugin: 'auto-model', key: 'line' } as const, { subagents: {} } as Line)
const routes = atom({ plugin: 'auto-model', key: 'routes' } as const, [] as Route[])
const now = atom({ plugin: 'auto-model', key: 'now' } as const, 0)

// The module's own: a reload loses it, which costs at most one turn's pick.
type Live = {
  style: Style
  switchDownUntil: number
  picker: PickerName
  configuredKey: string // the TypeSafe key set in /config
  openaiKey: string // the OpenAI key set in /config
  agents: 'auto' | 'suggest' | 'off' // what happens to a subagent's model
  ladder: Ladder
  keepNamed: boolean
  picks: Map<string, { pick: Pick | null; noPick?: string }>
  decisions: Map<string, Decision>
  previous?: string // what the last main turn ran on
  previousEffort?: string // and at what effort
}

export const register: Register = (on, options) => {
  const live: Live = {
    style: options.style === 'quality' ? 'quality' : 'saver',
    switchDownUntil: limitOf(options.switchDownUntil),
    picker: pickerOf(options.picker),
    configuredKey: typeof options.jevApiKey === 'string' ? options.jevApiKey.trim() : '',
    openaiKey: typeof options.openaiApiKey === 'string' ? options.openaiApiKey.trim() : '',
    agents: options.agents === 'suggest' || options.agents === 'off' ? options.agents : 'auto',
    ladder: options.agentModels === 'sonnet-opus-fable' ? 'sonnet-opus-fable' : 'haiku-sonnet-opus',
    keepNamed: options.keepNamed !== false,
    picks: new Map(),
    decisions: new Map(),
  }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    $.ui.status(undefined) // the plain line 0.1.0 pinned; the colored one below the hint replaces it
    await $.command.register({ name: 'auto-model', description: 'Turn auto model picking on or off, or show what it picked', argumentHint: '[on|off]' }).catch(() => {}) // a name already taken is refused: start anyway
    await $.command.register({ name: 'route', description: 'Show which model auto-model picked for each subagent, and what it cost' }).catch(() => {})
    // Redraws the band so a finished subagent leaves it after 30 s; quiet when nothing is shown.
    $.clock.every(5_000, () => void tickBand($).catch(() => {}))
    const model = await $.session.model().catch(() => undefined)
    const note: Note = { kind: (await isOn($)) ? 'on' : 'off' }
    await setLine($, l => (model && l.main?.phase !== 'running' ? { ...l, main: { ...l.main, model, note, phase: 'start' } } : l))
    await refreshMeter($)
    return r
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      live.previous = undefined
      live.previousEffort = undefined
      await setLine($, l => ({ ...l, subagents: {} }))
    }
    return next(e)
  })

  // Before a subagent starts: the picker chooses its model from the ladder, by its type and label alone.
  on('agent.spawn', async ($, e, next) => {
    if (live.agents === 'off' || e.fork || e.isTeammate) return next(e) // a fork runs on its parent's model; a teammate keeps the one it was given
    if (!(await isOn($))) return next(e) // /auto-model off leaves subagents alone too
    const asked = baseline(e)
    const named = live.keepNamed && !!e.model && e.model !== 'inherit'
    const pick: AgentPick = named ? { by: 'none', reason: 'named by the caller, kept' } : await pickForAgent($, live, e).catch(() => ({ by: 'none' as const, reason: 'picker failed, kept' }))
    const sure = pick.confidence === undefined || pick.confidence >= MIN_CONFIDENCE
    const apply = live.agents === 'auto' && sure && !!pick.tier && asked !== undefined && pick.tier !== tierOf(asked)
    const r = await next(apply ? { ...e, model: pick.tier } : e)
    if (r.deny !== undefined) return r
    const one: Route = {
      id: e.tool_use_id,
      agentId: r.agentId,
      description: e.description || e.name || e.subagentType,
      type: e.subagentType,
      asked,
      picked: pick.tier,
      by: pick.by,
      confidence: pick.confidence,
      reason: sure ? pick.reason : `${pick.reason}, too unsure to switch`,
      applied: apply,
      status: 'running',
      startedAt: Date.now(),
      model: r.model,
      pickerUsd: pick.pickerUsd,
    }
    await update($, routes, list => trim([one, ...list.filter(x => x.id !== one.id)])).catch(() => {})
    if (pick.pickerUsd) await update($, stats, s => ({ ...s, jevUsd: s.jevUsd + (pick.pickerUsd ?? 0) })).catch(() => {})
    return r
  })

  // Asks Jev before the turn's first request, so every request of the turn can name the pick.
  on('turn.start', async ($, e, next) => {
    live.picks.set(e.turnId, await pickFor($, live, e.text))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // A subagent's request: shown, never changed.
    if (e.agentId) {
      const id = e.agentId
      await setLine($, l => ({ ...l, subagents: { ...l.subagents, [id]: { model: e.model, at: Date.now() } } }))
      const r = yield* next(e)
      const ran = r.usage?.model
      if (ran) await setLine($, l => (l.subagents[id] ? { ...l, subagents: { ...l.subagents, [id]: { model: ran, at: Date.now() } } } : l))
      return r
    }
    let d = live.decisions.get(e.turnId)
    if (!d) {
      d = await firstStep($, live, e.turnId, e.model, e.effort)
      live.decisions.set(e.turnId, d)
    }
    const model = d.rewrite && tierOf(e.model) !== d.tier ? d.rewrite : e.model
    const effort = d.effortRewrite && effortOf(e.effort) && e.effort !== d.effortRewrite ? d.effortRewrite : e.effort
    const main = { model, note: d.note, phase: 'running' as const, ...(typeof effort === 'string' ? { effort, effortNote: d.effortNote ?? ('kept' as const) } : {}) }
    await setLine($, l => ({ ...l, main }))
    const r = yield* next(model === e.model && effort === e.effort ? e : { ...e, model, effort })
    const ran = r.usage?.model // the API's word on what answered
    if (ran && ran !== model) await setLine($, l => (l.main ? { ...l, main: { ...l.main, model: ran } } : l))
    await refreshMeter($)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) {
      const id = e.agentId
      await setLine($, l => {
        const { [id]: _, ...rest } = l.subagents
        return { ...l, subagents: rest }
      })
      await recordAgentTurn($, id, e.reason === 'error' || e.reason === 'aborted', r.usage)
      return r
    }
    live.picks.delete(e.turnId)
    const stepped = live.decisions.delete(e.turnId)
    const main = (await read($, line)).main
    if (stepped && main) {
      const ran = e.usage?.model ?? main.model
      live.previous = ran
      live.previousEffort = main.effort
      await setLine($, l => ({ ...l, main: { ...main, model: ran, phase: 'done' } }))
      const l = label(ran)
      await update($, stats, s => ({ ...s, turns: { ...s.turns, [l]: (s.turns[l] ?? 0) + 1 } })).catch(() => {})
    }
    await refreshMeter($)
    return r
  })

  // The bar under the prompt, drawn above the engine's own hint line. Only the terminal draws that
  // line: elsewhere (the desktop's Code tab) the bar goes in the band above the prompt instead.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const hint = await next(e)
    if (e.surface !== 'terminal') return hint
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await bar($, Text)}
        {hint}
      </Box>
    )
  })

  // The subagents running now, or finished in the last 30 s, above the prompt; off the terminal,
  // the bar too, on top.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    await read($, now) // subscribes the band to the clock
    const shown = (await read($, routes)).filter(r => isShown(r))
    const withBar = e.surface !== 'terminal'
    if (e.props.hasSurvey || (shown.length === 0 && !withBar)) return rest
    const { Box, Text } = $.ui.resolve(e)
    const mode = live.agents === 'suggest' ? 'suggest' : 'auto'
    return (
      <Box flexDirection="column">
        {withBar && (await bar($, Text))}
        {shown.slice(0, BAND_ROWS).map(r => (
          <Text wrap="truncate-end">
            <Text color={routeColor(r)} bold>{` ⇄ ${r.description}`}</Text>
            <Text>{`  ${move(r, mode)}`}</Text>
            <Text dimColor>{`  ${source(r)}${r.status === 'running' ? '' : ` · ${usdOrUnknown(r.costUsd)}`}`}</Text>
          </Text>
        ))}
        {shown.length > BAND_ROWS && <Text dimColor>{`   +${shown.length - BAND_ROWS} more · /route`}</Text>}
        {rest}
      </Box>
    )
  })

  on('command.run', { command: 'route' }, async $ => {
    await $.ui.open({ id: ROUTE_PANE, title: 'Subagent models', focus: true })
    const t = totals(await read($, routes))
    return { text: `${t.count} subagents, ${t.switched} switched · ${usdOrUnknown(t.cost)} spent, ${usdOrUnknown(t.asked)} at the asked models` }
  })

  on('ui.render', { component: 'Pane', requestId: ROUTE_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, routes)
    const t = totals(list)
    const keyless = live.agents !== 'off' && !(await keyOf($, live))
    const name = PICKER_LABEL[live.picker]
    const mode = live.agents === 'suggest' ? 'suggest' : 'auto'
    return (
      <Box flexDirection="column">
        <Text bold>{`${t.count} subagents · ${t.switched} switched · subagents: ${live.agents} · picker ${name}${keyless ? ` (${noKey(live.picker)}, nothing changes)` : ''}`}</Text>
        <Text>
          <Text>{`spent ${usdOrUnknown(t.cost)}`}</Text>
          <Text dimColor>{` · at the asked models ${usdOrUnknown(t.asked)} · picks ${usdOrUnknown(t.picker)}`}</Text>
        </Text>
        <Text dimColor>{`API price estimates as of ${PRICES_AS_OF}, not plan charges. ? = not known yet.`}</Text>
        <Text dimColor>{'─'.repeat(Math.max(10, e.props.bodyColumns - 2))}</Text>
        {list.length === 0 && <Text dimColor>No subagents yet this session.</Text>}
        {list.slice(0, PANE_ROWS).map(r => (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={routeColor(r)} bold>{`${routeIcon(r)} ${r.description}`}</Text>
              <Text>{`  ${move(r, mode)}`}</Text>
              <Text dimColor>{`  ${r.status === 'running' ? 'running' : `${usdOrUnknown(r.costUsd)} (asked ${usdOrUnknown(r.askedUsd)})`}`}</Text>
            </Text>
            <Text dimColor wrap="truncate-end">{`   ${r.type} · ${r.by === 'none' ? r.reason : `${source(r)} · ${r.reason}`}${r.model ? ` · ran on ${r.model}` : ''}`}</Text>
          </Box>
        ))}
        {list.length > PANE_ROWS && <Text dimColor>{`… ${list.length - PANE_ROWS} older`}</Text>}
        <Box flexDirection="row" gap={1}>
          <Button key="clear" label="Clear finished" hotkey="c" onPress={() => update($, routes, all => all.filter(x => x.status === 'running'))} />
          <Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: ROUTE_PANE })} />
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'auto-model' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await $.store.set(ENABLED, arg === 'on')
      const note: Note = { kind: arg }
      await setLine($, l => (l.main && l.main.phase !== 'running' ? { ...l, main: { ...l.main, note } } : l))
      return { text: arg === 'on' ? `auto-model on: ${PICKER_LABEL[live.picker]} picks the main model for each prompt.` : 'auto-model off: prompts and subagents run on the models they were given.' }
    }
    const s = await read($, stats)
    const turns = Object.entries(s.turns).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ×${n}`).join(', ') || 'none yet'
    const keyless = !(await keyOf($, live))
    const limit = Number.isFinite(live.switchDownUntil) ? `${live.switchDownUntil / 1000}k` : 'any'
    return {
      text: [
        `auto-model ${(await isOn($)) ? 'on' : 'off'} · picker ${PICKER_LABEL[live.picker]}${keyless ? ` (${noKey(live.picker)}: nothing changes)` : ''} · style ${live.style} · switches down until ${limit} context tokens`,
        `turns this session: ${turns} · ${s.switched} on a cheaper model · ${s.lowered ?? 0} at lower effort · picks ${usd(s.jevUsd)}`,
        `subagents: ${live.agents} · ${agentSummary(await read($, routes))} · /route for each`,
      ].join('\n'),
    }
  })
}

// The colored line: the main model and its note, effort, context, 7-day limit and the subagents running.
async function bar($: EngineInterface, Text: ElementConstructor<TextProps>) {
  const { main, meter, subagents } = await read($, line)
  const now = Date.now()
  const running = Object.values(subagents)
    .filter(s => now - s.at < SUBAGENT_STALE_MS)
    .map(s => s.model)
  return (
    <Text wrap="truncate-end">
      {segments({ main, meter }, running).map(s => (
        <Text {...style(s)}>{s.text}</Text>
      ))}
    </Text>
  )
}

// A segment's style as Text props, leaving out what it does not set.
function style(s: Seg) {
  return {
    ...(s.color ? { color: s.color } : {}),
    ...(s.bg ? { backgroundColor: s.bg } : {}),
    ...(s.bold ? { bold: true } : {}),
    ...(s.dim ? { dimColor: true } : {}),
    ...(s.strike ? { strikethrough: true } : {}),
  }
}

// The context and 7-day figures, read after each request and turn.
async function refreshMeter($: EngineInterface) {
  const meter = meterOf(await $.session.usage().catch(() => undefined))
  if (meter) await setLine($, l => ({ ...l, meter }))
}

async function setLine($: EngineInterface, fn: (l: Line) => Line) {
  await update($, line, l => fn(l ?? { subagents: {} })).catch(() => {})
}

async function isOn($: EngineInterface) {
  return (await $.store.get(ENABLED).catch(() => undefined)) !== false
}

// The chosen picker's key: the one set in /config, else the environment's. Claude needs none: it
// answers through the session's own client.
async function keyOf($: EngineInterface, live: Live) {
  if (live.picker === 'claude') return 'session'
  if (live.picker === 'openai') return live.openaiKey || ((await $.env.get('OPENAI_API_KEY').catch(() => undefined)) ?? '').trim()
  return live.configuredKey || ((await $.env.get('TYPESAFE_API_KEY').catch(() => undefined)) ?? '').trim()
}

function noKey(picker: PickerName) {
  return picker === 'openai' ? 'no OpenAI key' : 'no TypeSafe key'
}

// Asks the chosen picker the questions over the state; its answers when it answers in time,
// otherwise null and nothing changes.
async function askPicker($: EngineInterface, live: Live, key: string, state: object, questions: Question[], timeoutMs: number): Promise<Answered | null> {
  if (live.picker === 'claude') {
    const { system, prompt } = claudeAsk(state, questions)
    const r = await $.model.complete({ model: CLAUDE_PICK_MODEL, system, prompt, maxTokens: 300, effort: 'low', timeoutMs: CLAUDE_PICK_TIMEOUT_MS }).catch(() => null)
    return r?.isAnswered ? parseClaudeAnswers(r.text, questions, r.usage) : null
  }
  const openai = live.picker === 'openai'
  const timeout = $.clock.sleep(timeoutMs).then(
    () => null,
    () => null,
  )
  const answer = $.http
    .fetch(openai ? OPENAI_URL : JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(openai ? openaiBody(state, questions) : jevBody(state, questions)),
    })
    .then(r => (r.ok ? (openai ? parseOpenaiAnswers : parseJevAnswers)(r.text, questions) : null))
    .catch(() => null)
  return Promise.race([answer, timeout])
}

async function pickFor($: EngineInterface, live: Live, text: string): Promise<{ pick: Pick | null; noPick?: string }> {
  if (!(await isOn($))) return { pick: null, noPick: 'off' }
  if (!text.trim()) return { pick: null, noPick: 'no prompt to judge' }
  const base = (await $.session.model().catch(() => undefined)) ?? ''
  const ceiling = tierOf(base)
  if (!ceiling) return { pick: null, noPick: 'a model it does not know' }
  if (ceiling === 'haiku') return { pick: null, noPick: 'nothing below Haiku' }
  const key = await keyOf($, live)
  if (!key) return { pick: null, noPick: noKey(live.picker) }
  const model = live.previous ?? base
  await setLine($, l => ({ ...l, main: { model, note: { kind: 'asking', by: live.picker }, phase: 'running' } }))
  const choices = choicesUpTo(ceiling)
  const state = mainState(text, { tier: tierOf(live.previous), effort: effortOf(live.previousEffort) })
  const pick = mainPickOf(await askPicker($, live, key, state, mainQuestions(choices, live.style), PICK_TIMEOUT_MS), choices)
  if (!pick) return { pick: null, noPick: `${PICKER_LABEL[live.picker]} did not answer` }
  await update($, stats, s => ({ ...s, jevUsd: s.jevUsd + pick.costUsd })).catch(() => {})
  return { pick }
}

// The turn's decision, made once at its first request, from the model the engine resolved.
async function firstStep($: EngineInterface, live: Live, turnId: string, model: string, effort: unknown): Promise<Decision> {
  const p = live.picks.get(turnId)
  live.picks.delete(turnId)
  const asIs = effortOf(effort) ? { effort: effortOf(effort), effortNote: 'kept' as const } : {}
  if (p?.noPick === 'off') return { tier: tierOf(model), base: model, note: { kind: 'off' }, ...asIs }
  if (!p) return { tier: tierOf(model), base: model, note: { kind: 'none', reason: 'no pick for this turn' }, ...asIs }
  const usage = await $.session.usage().catch(() => undefined)
  const d = decide({
    base: model,
    baseEffort: effort,
    previous: live.previous,
    previousEffort: live.previousEffort,
    pick: p.pick,
    noPick: p.noPick,
    contextTokens: usage?.context.tokens,
    switchDownUntil: live.switchDownUntil,
    minConfidence: MIN_CONFIDENCE,
    by: live.picker,
  })
  if (d.rewrite || d.effortRewrite) await update($, stats, s => ({ ...s, switched: s.switched + (d.rewrite ? 1 : 0), lowered: (s.lowered ?? 0) + (d.effortRewrite ? 1 : 0) })).catch(() => {})
  return d
}

type AgentPick = { tier?: Tier; by: Route['by']; confidence?: number; reason: string; pickerUsd?: number }

// The picker's choice for a subagent when it answers in time; otherwise no pick, and nothing changes.
async function pickForAgent($: EngineInterface, live: Live, e: { subagentType: string; description: string }): Promise<AgentPick> {
  const key = await keyOf($, live)
  if (!key) return { by: 'none', reason: noKey(live.picker) }
  const name = PICKER_LABEL[live.picker]
  const got = agentPickOf(await askPicker($, live, key, agentState(e), agentQuestions(live.ladder, live.style), AGENT_PICK_TIMEOUT_MS), LADDERS[live.ladder])
  if (!got) return { by: 'none', reason: `${name} did not answer` }
  return { tier: got.tier, by: live.picker, confidence: got.confidence, reason: `${name} picked ${got.tier}`, pickerUsd: got.costUsd }
}

// One subagent turn's tokens, counted once: a turn.complete is one turn.
async function recordAgentTurn($: EngineInterface, id: string, failed: boolean, usage: (Route['usage'] & { model?: string }) | undefined) {
  await update($, routes, list =>
    list.map(x => {
      if (x.agentId !== id) return x
      const total = usage ? addUsage(x.usage, usage) : x.usage
      // What it ran on: the API's word, else the switch we made, else what was asked.
      const model = usage?.model ?? x.model ?? (x.applied ? x.picked : x.asked) ?? x.picked ?? ''
      return {
        ...x,
        status: failed ? ('failed' as const) : ('done' as const),
        endedAt: Date.now(),
        model,
        usage: total,
        costUsd: total ? costOf(model, total) : x.costUsd,
        // Not switched, it ran on what was asked; switched, the same tokens at the asked model's prices.
        askedUsd: !total ? x.askedUsd : x.applied && x.asked ? costOf(x.asked, total) : costOf(model, total),
      }
    }),
  ).catch(() => {})
}

async function tickBand($: EngineInterface) {
  if ((await read($, routes)).some(r => isShown(r, Date.now() - 5_000))) await update($, now, () => Date.now())
}

function agentSummary(list: Route[]) {
  const t = totals(list)
  return `${t.count} this session, ${t.switched} switched`
}

function source(r: Route) {
  return r.by === 'none' ? r.reason : `${r.by} ${Math.round((r.confidence ?? 0) * 100)}% sure`
}

function routeIcon(r: Route) {
  return r.status === 'running' ? '●' : r.status === 'done' ? '✓' : '✗'
}

function routeColor(r: Route) {
  return r.status === 'running' ? 'yellow' : r.status === 'done' ? 'green' : 'red'
}
