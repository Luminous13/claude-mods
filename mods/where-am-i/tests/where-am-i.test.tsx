import { describe, expect, mock, test } from 'claude-code/testing'

import { choices, describe as label, fitsCard, parseRecap, parseSteps, words } from '../hooks/register'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 14, bodyColumns: 120 } }
const RECAP = '{"goal":"Ship 3 mods","now":"built Where Am I","waiting":"you to test it","next":"Rulebook Guard"}'
const ANSWER = 'I wrote tests for the login form and they pass locally.'
const REPLY = 'Run the tests you just wrote\nDo the same for settings\nOpen a draft PR'

const wait = () => new Promise(done => (globalThis as any).setTimeout(done, 10))

// Stands for the engine beneath the mod. The recap and the suggestions are told apart by their
// system prompt; `steps` may hold the suggestions call until the test lets it go.
function engine(on: any, recap: string, o: { steps?: () => Promise<string> | string; agents?: unknown[] } = {}) {
  const calls = { recap: 0, steps: 0 }
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('prompt.submit', () => ({ text: '' }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.list', () => ({ value: o.agents ?? [] }))
  on('model.complete', async (_$: any, e: any) => {
    const isSteps = /predict what a person will type next/.test(e.system ?? '')
    isSteps ? calls.steps++ : calls.recap++
    const text = isSteps ? await (o.steps ?? (() => ''))() : recap
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } }
  })
  on('session.messages', () => ({ value: [{ role: 'user', text: 'build the mods', toolUses: [] }] }))
  on('prompt.fill', () => ({ value: undefined }))
  // The editor: splice what was typed into the draft.
  on('prompt.edit', (_$: any, e: any) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length }
  })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'band below' }) // stands for other mods and the engine's own band
  })
  return calls
}

async function recapped($: any, turnId = 't1', answer = ANSWER) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await $.prompt.submit({ text: 'ship all 3' } as any)
  await $.turn.start({ text: 'ship all 3', turnId } as any)
  await $.tool.call({ tool: 'Write', file_path: '/work/a/b.ts', content: 'x' } as any)
  await $.turn.complete({ reason: 'answer', answer, durationMs: 1, isAborted: false, turnId } as any)
  await wait()
}

const mount = ($: any, props: Record<string, unknown> = {}) => $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND, props: { ...BAND.props, ...props } } as any)

// A keystroke in the prompt, as the editor raises it.
const edit = ($: any, e: unknown) => $.prompt.edit(e)

const key = (text: string, inputText: string) => ({
  origin: { kind: 'composer' },
  text,
  cursor: text.length,
  start: text.length,
  end: text.length,
  inputText,
  key: { key: inputText },
})

describe('where-am-i: the recap', () => {
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

  test('/where answers with a summary', async ($, on) => {
    engine(on, '- Goal: ship 3 mods')
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const r = await $.command.run({ command: 'where', args: '' } as any)
    expect(r.text).toBe('- Goal: ship 3 mods')
  })
})

describe('where-am-i: the suggested next steps, in the same card', () => {
  test('after a turn: the suggestions inside the card, in place of next, with clickable badges', async ($, on) => {
    engine(on, RECAP, { steps: () => REPLY })
    await recapped($)
    const ui = await mount($)
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.match(/"borderStyle":"round"/g)?.length).toBe(1) // one card, never two
    expect(await ui.find({ type: 'Text', text: /^Ship $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Suggested $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^click one, or type ; then a number$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Run the tests you just wrote$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', label: '3' })).toBeDefined()
    expect(await ui.find({ type: 'Button', label: '0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Rulebook Guard$/ })).toBeUndefined() // the suggestions stand in for next
    for (const c of ['#f472b6', '#a5b4fc', '#5eead4', '#f9a8d4', '#c7d2fe', '#99f6e4']) expect(drawn).toContain(c)
    await ui.unmount()
  })

  test('the leader then a digit drafts that suggestion; a bare digit types as usual', async ($, on) => {
    engine(on, RECAP, { steps: () => REPLY })
    await recapped($)
    expect((await edit($, key('', '1') as any)).text).toBe('1')
    expect((await edit($, key('', ';') as any)).text).toBe(';')
    const r = await edit($, key(';', '2') as any)
    expect(r.text).toBe('Do the same for settings')
    expect(r.cursor).toBe('Do the same for settings'.length)
    expect((await edit($, key(';', '7') as any)).text).toBe(';7') // no suggestion 7
    expect((await edit($, key('a;', '1') as any)).text).toBe('a;1')
    const { key: _key, ...paste } = key(';', '1')
    expect((await edit($, paste as any)).text).toBe(';1') // a paste carries no key
  })

  test('typing the leader arms the card: a yellow border and the bare digits', async ($, on) => {
    engine(on, RECAP, { steps: () => REPLY })
    await recapped($)
    await edit($, key('', ';') as any)
    const ui = await mount($)
    expect(JSON.stringify(await ui.drawn())).toContain('"borderColor":"warning"')
    expect(await ui.find({ type: 'Text', text: /^press 1, 2 or 3 · 0 dismisses$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ 3 $/ })).toBeDefined()
    await ui.unmount()
  })

  test('the leader then 0 dismisses: the box empties and next comes back', async ($, on) => {
    engine(on, RECAP, { steps: () => REPLY })
    await recapped($)
    expect((await edit($, key(';', '0') as any)).text).toBe('')
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: /Run the tests/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Rulebook Guard$/ })).toBeDefined()
    await ui.unmount()
    expect((await edit($, key(';', '1') as any)).text).toBe(';1') // nothing left to pick
  })

  test('another leader from /config', { options: { leader: ',' } }, async ($, on) => {
    engine(on, RECAP, { steps: () => REPLY })
    await recapped($)
    expect((await edit($, key(';', '1') as any)).text).toBe(';1')
    expect((await edit($, key(',', '1') as any)).text).toBe('Run the tests you just wrote')
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: /^click one, or type , then a number$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a band too short or narrow for the card gets compact lines, badges included', async ($, on) => {
    engine(on, RECAP, { steps: () => REPLY })
    await recapped($)
    for (const props of [{ maxRows: 5 }, { bodyColumns: 30 }]) {
      const ui = await mount($, props)
      expect(JSON.stringify(await ui.drawn())).not.toContain('"borderStyle":"round"')
      expect(await ui.find({ type: 'Text', text: /^Ship $/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', label: '1' })).toBeDefined()
      expect(await ui.find({ type: 'Button', label: '0' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a result that lands after a newer turn or a sent prompt is dropped', async ($, on) => {
    let release: (s: string) => void = () => {}
    const held = new Promise<string>(done => (release = done))
    engine(on, RECAP, { steps: () => held })
    await recapped($, 't1')
    await $.prompt.submit({ text: 'go on' } as any)
    await $.turn.start({ text: 'go on', turnId: 't2' } as any)
    release(REPLY)
    await wait()
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: /Run the tests/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a sent prompt clears the list', async ($, on) => {
    engine(on, RECAP, { steps: () => REPLY })
    await recapped($)
    await $.prompt.submit({ text: 'go on' } as any)
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: /Run the tests/ })).toBeUndefined()
    await ui.unmount()
  })

  test('no suggestions call after a trivial turn or a subagent turn', async ($, on) => {
    const calls = engine(on, RECAP, { steps: () => REPLY })
    await recapped($, 't1', 'Done.')
    await $.turn.complete({ reason: 'answer', answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'x', agentId: 'a1' } as any)
    await wait()
    expect(calls.steps).toBe(0)
  })

  test('waits while background agents still run', async ($, on) => {
    const calls = engine(on, RECAP, { steps: () => REPLY, agents: [{ id: 'a1', description: 'tests', type: 'general-purpose', status: 'running' }] })
    await recapped($)
    expect(calls.steps).toBe(0)
  })

  test('the suggestions show even before the first recap lands', async ($, on) => {
    engine(on, 'not json', { steps: () => REPLY })
    await recapped($)
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: /^Run the tests you just wrote$/ })).toBeDefined()
    await ui.unmount()
  })

  test('turned off in /config: no suggestions call, next stays, the leader types as usual', { options: { nextSteps: false } }, async ($, on) => {
    const calls = engine(on, RECAP, { steps: () => REPLY })
    await recapped($)
    expect(calls.recap).toBe(1)
    expect(calls.steps).toBe(0)
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: /Suggested/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Rulebook Guard$/ })).toBeDefined()
    await ui.unmount()
    expect((await edit($, key(';', '1') as any)).text).toBe(';1')
  })
})

describe('where-am-i: helpers', () => {
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

  test('cleans the model lines', () => {
    expect(parseSteps('1. Run the tests.\n- Open a PR — draft\n\n* "Ship it"\nfour')).toEqual(['Run the tests', 'Open a PR, draft', 'Ship it'])
    expect(parseSteps('["a", "b"]')).toEqual(['a', 'b'])
    expect(parseSteps('```json\n["Run the tests", "Ship it"]\n```')).toEqual(['Run the tests', 'Ship it'])
    expect(parseSteps('{"prompts": ["Run it"]}')).toEqual(['Run it'])
    expect(parseSteps(RECAP)).toEqual([])
    expect(parseSteps('NONE')).toEqual([])
    expect(parseSteps('Here are some ideas:\nrun it\nRun it')).toEqual(['run it'])
    expect(parseSteps(`${'word '.repeat(30)}\nshort one`)).toEqual(['short one']) // too long: dropped, not cut
  })

  test('the card fits by rows and columns', () => {
    expect(fitsCard(6, 14, 120)).toBe(true)
    expect(fitsCard(6, 5, 120)).toBe(false)
    expect(fitsCard(6, 14, 30)).toBe(false)
  })
})
