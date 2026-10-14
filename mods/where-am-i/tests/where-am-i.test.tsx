import { describe, expect, mock, test } from 'claude-code/testing'

import { choices, describe as label, parseRecap, words } from '../hooks/register'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 14, bodyColumns: 120 } }
const RECAP = '{"goal":"Ship 3 mods","now":"built Where Am I","waiting":"you to test it","next":"Rulebook Guard"}'

const wait = () => new Promise(done => (globalThis as any).setTimeout(done, 10))

// Stands for the engine beneath the mod.
function engine(on: any, reply: string) {
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('prompt.submit', () => ({ text: '' }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'sweep runner', type: 'general-purpose', status: 'running' }] }))
  on('model.complete', () => ({ value: { isAnswered: true, text: reply, usage: { input_tokens: 1, output_tokens: 1 } } }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'build the mods', toolUses: [] }] }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'band below' }) // stands for Token Weather and the engine's own band
  })
}

// Stands for the next-steps mod's values: its list, whether the leader is typed, the leader.
function nextSteps(on: any, o: { items?: string[]; armed?: boolean; leader?: string }) {
  const v = (value: unknown) => () => ({ value: { value, version: value === undefined ? 0 : 1 } })
  on('state.get', { plugin: 'next-steps', key: 'active' }, v(o.items ? true : undefined))
  on('state.get', { plugin: 'next-steps', key: 'steps' }, v(o.items ? { turnId: 't', items: o.items } : undefined))
  on('state.get', { plugin: 'next-steps', key: 'armed' }, v(o.armed))
  on('state.get', { plugin: 'next-steps', key: 'leader' }, v(o.leader))
}

async function recapped($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await $.prompt.submit({ text: 'ship all 3' } as any)
  await $.tool.call({ tool: 'Write', file_path: '/work/a/b.ts', content: 'x' } as any)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
  await wait()
}

const mount = ($: any, props: Record<string, unknown> = {}) => $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND, props: { ...BAND.props, ...props } } as any)

describe('where-am-i', () => {
  test('one card: the goal as its title, then now, waiting on you and next with their status', async ($, on) => {
    engine(on, '```json\n' + RECAP + '\n```')
    await recapped($)
    const ui = await mount($)
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('"borderStyle":"round"')
    expect(drawn).toContain('"borderColor":"#fb7185"')
    for (const w of ['Ship ', '3 ', 'mods']) expect(await ui.find({ type: 'Text', text: new RegExp(`^${w}$`) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^built Where Am I$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Done$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^you to test it$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Waiting on you$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Rulebook Guard$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Next$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /band below/ })).toBeDefined()
    await ui.unmount()
  })

  test('every row in its own color, like the auto-model bar', async ($, on) => {
    engine(on, RECAP)
    nextSteps(on, { items: ['Run the tests', 'Open a draft PR', 'Ship it'] })
    await recapped($)
    const ui = await mount($)
    const drawn = JSON.stringify(await ui.drawn())
    for (const c of ['#34d399', '#a7f3d0', '#fdba74', '#f9a8d4', '#c7d2fe', '#99f6e4']) expect(drawn).toContain(c)
    await ui.unmount()
  })

  test('waiting and next rows in yellow and lavender', async ($, on) => {
    engine(on, RECAP)
    await recapped($)
    const ui = await mount($)
    const drawn = JSON.stringify(await ui.drawn())
    for (const c of ['#fbbf24', '#fde68a', '#c4b5fd', '#ddd6fe']) expect(drawn).toContain(c)
    await ui.unmount()
  })

  test('the pulse moves while Claude works and stops once the turn ends', async ($, on) => {
    engine(on, RECAP)
    const clock = mock.clock(on)
    await recapped($)
    await $.prompt.submit({ text: 'again' } as any)
    const colors = async () => {
      const ui = await mount($, { isWorking: true })
      const drawn = JSON.stringify(await ui.drawn())
      await ui.unmount()
      return drawn
    }
    const first = await colors()
    await clock.advance(150)
    await wait()
    const second = await colors()
    expect(second).not.toBe(first)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
    await clock.advance(150)
    await wait()
    const idle = JSON.stringify(await (await mount($)).drawn())
    await clock.advance(600)
    await wait()
    expect(JSON.stringify(await (await mount($)).drawn())).toBe(idle)
  })

  test('while Claude works: what it is doing, the pulse and Working; no stale ask', async ($, on) => {
    engine(on, RECAP)
    await recapped($)
    await $.prompt.submit({ text: 'again' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/work/a/b.ts' } as any)
    const ui = await mount($, { isWorking: true })
    expect(await ui.find({ type: 'Text', text: /^reading a\/b.ts$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Working/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▇$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Waiting on you$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('the next-steps suggestions inside the same card, with their keys', async ($, on) => {
    engine(on, RECAP)
    nextSteps(on, { items: ['Run the tests', 'Open a draft PR'] })
    await recapped($)
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: /^Suggested $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^steps$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^click one, or type ; then a number$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Run the tests$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', label: '2' })).toBeDefined() // a pill a click presses
    expect(await ui.find({ type: 'Button', label: '0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^;2$/ })).toBeUndefined() // the leader stays out of the badge
    expect(await ui.find({ type: 'Text', text: /^Rulebook Guard$/ })).toBeUndefined() // the suggestions stand in for next
    await ui.unmount()
  })

  test('with the leader typed: a yellow border and the bare digits', async ($, on) => {
    engine(on, RECAP)
    nextSteps(on, { items: ['Run the tests', 'Open a draft PR', 'Ship it'], armed: true, leader: ',' })
    await recapped($)
    const ui = await mount($)
    expect(JSON.stringify(await ui.drawn())).toContain('"borderColor":"warning"')
    expect(await ui.find({ type: 'Text', text: /^press 1, 2 or 3 · 0 dismisses$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ 3 $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^,3$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a band too short or narrow for the card gets compact lines', async ($, on) => {
    engine(on, RECAP)
    nextSteps(on, { items: ['Run the tests', 'Open a draft PR'] })
    await recapped($)
    for (const props of [{ maxRows: 5 }, { bodyColumns: 30 }]) {
      const ui = await mount($, props)
      expect(JSON.stringify(await ui.drawn())).not.toContain('"borderStyle":"round"')
      expect(await ui.find({ type: 'Text', text: /^Ship $/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^◆ waiting on you: $/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', label: '1' })).toBeDefined() // the card's clickable badges
      expect(await ui.find({ type: 'Button', label: '0' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^ 1 $/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /;1/ })).toBeUndefined() // no leader in compact mode either
      await ui.unmount()
    }
  })

  test('says it hosts the card, so next-steps leaves its list to it', async ($, on) => {
    engine(on, RECAP)
    const set: unknown[] = []
    on('state.set', { plugin: 'where-am-i', key: 'hosts' }, (_$: any, e: any, next: any) => (set.push(e.value), next(e)))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    expect(set).toEqual([true])
  })

  // Stands for glance: a mod that calls an MCP tool in the background, as `$.mcp.call` does.
  const glance = {
    name: 'glance',
    register(on: any) {
      on('command.run', { command: 'peek' }, async ($: any) => {
        await $.tool.call({ tool: 'mcp__claude_ai_Slack__slack_search_public_and_private', query: 'x' })
        return { text: 'peeked' }
      })
    },
  }

  test('a call another mod makes does not change now; one Claude makes does', { plugins: [glance] }, async ($, on) => {
    engine(on, '{"goal":"Ship 3 mods","now":"built Where Am I","waiting":"","next":"Rulebook Guard"}')
    on('command.run', () => ({ text: '' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
    await wait()

    // Idle: glance checks Slack in the background.
    await $.command.run({ command: 'peek', args: '' } as any)
    const idle = await mount($)
    expect(await idle.find({ type: 'Text', text: /^built Where Am I$/ })).toBeDefined()
    expect(await idle.find({ type: 'Text', text: /slack/ })).toBeUndefined()
    await idle.unmount()

    // Claude's own call shows as now.
    await $.prompt.submit({ text: 'ship all 3' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/work/a/b.ts' } as any)
    const busy = await mount($)
    expect(await busy.find({ type: 'Text', text: /^reading a\/b.ts$/ })).toBeDefined()
    await busy.unmount()
  })

  test('/recap answers with a summary', async ($, on) => {
    engine(on, '- Goal: ship 3 mods')
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const r = await $.command.run({ command: 'where', args: '' } as any)
    expect(r.text).toBe('- Goal: ship 3 mods')
  })

  test('labels tool calls in plain words', () => {
    expect(label({ tool: 'Bash', description: 'Run tests' })).toBe('running Run tests')
    expect(label({ tool: 'Edit', file_path: '/a/b/c.ts' })).toBe('editing b/c.ts')
    expect(label({ tool: 'mcp__claude_ai_Slack__slack_send_message' })).toBe('using claude_ai_Slack slack_send_message')
  })

  test('reads the JSON and drops em dashes', () => {
    expect(parseRecap('{"goal":"A — B","now":"","waiting":"","next":""}')?.goal).toBe('A, B')
    expect(parseRecap('no json here')).toBeNull()
    const long = parseRecap('{"goal":"g","now":"Part A of Merge Gate passed. Codex rules block without the luna model and codex exec too.","waiting":"","next":""}')
    expect(long?.now).toBe('Part A of Merge Gate passed')
  })

  test('title words and key choices', () => {
    expect(words('Ship 3 mods')).toEqual(['Ship ', '3 ', 'mods'])
    expect(choices(3)).toBe('1, 2 or 3')
    expect(choices(2)).toBe('1 or 2')
    expect(choices(1)).toBe('1')
  })
})
