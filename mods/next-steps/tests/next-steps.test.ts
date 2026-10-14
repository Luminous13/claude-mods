import { describe, expect, test } from 'claude-code/testing'

import { fitsOnOneLine, parseSteps } from '../hooks/register'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160 } }
const ANSWER = 'I wrote tests for the login form and they pass locally.'
const REPLY = 'Run the tests you just wrote\nDo the same for settings\nOpen a draft PR'

const wait = () => new Promise(done => (globalThis as any).setTimeout(done, 10))

// Stands for the engine beneath the mod. `reply` may hold the model call until the test lets it go.
function engine(on: any, reply: () => Promise<string> | string, agents: unknown[] = []) {
  let calls = 0
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('prompt.submit', () => ({ text: '' }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.list', () => ({ value: agents }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'add tests for the login form', toolUses: [] }] }))
  on('model.complete', async () => {
    calls++
    return { value: { isAnswered: true, text: await reply(), usage: { input_tokens: 1, output_tokens: 1 } } }
  })
  // The editor: splice what was typed into the draft.
  on('prompt.edit', (_$: any, e: any) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length }
  })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'band below' }) // stands for other mods' bands
  })
  return { calls: () => calls }
}

async function finishTurn($: any, turnId = 't1', answer = ANSWER) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'add tests', turnId })
  await $.turn.complete({ reason: 'answer', answer, durationMs: 1, isAborted: false, turnId })
  await wait()
}

const band = ($: any, columns = 160, rows = 10) =>
  $.ui.mount({ plugin: 'next-steps', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: columns, maxRows: rows } })

const key = (text: string, inputText: string) => ({
  origin: { kind: 'composer' },
  text,
  cursor: text.length,
  start: text.length,
  end: text.length,
  inputText,
  key: { key: inputText },
})

describe('next-steps', () => {
  test('shows the suggestions after a turn, above what was already there', async ($, on) => {
    engine(on, () => REPLY)
    await finishTurn($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /^Suggested $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^3 ideas · type ; then a number$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Run the tests you just wrote$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Open a draft PR$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^;1$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^;0$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Dismiss$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /band below/ })).toBeDefined()
    await ui.unmount()
  })

  test('a band too short for the card draws the compact row', async ($, on) => {
    engine(on, () => REPLY)
    await finishTurn($)
    let ui = await band($, 160, 4)
    expect(await ui.find({ type: 'Text', text: /^✦ next $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ ;1 $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Suggested/ })).toBeUndefined()
    await ui.unmount()
    ui = await band($, 30) // too narrow for the card too
    expect(await ui.find({ type: 'Text', text: /^✦ next $/ })).toBeDefined()
    await ui.unmount()
  })

  test('ignores a result that arrives after a newer turn started', async ($, on) => {
    let release: (s: string) => void = () => {}
    const held = new Promise<string>(done => (release = done))
    engine(on, () => held)
    await finishTurn($, 't1')
    await $.turn.start({ text: 'something else', turnId: 't2' } as any)
    release(REPLY)
    await wait()
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Run the tests/ })).toBeUndefined()
    await ui.unmount()
  })

  test('the leader then a digit drafts that suggestion', async ($, on) => {
    engine(on, () => REPLY)
    await finishTurn($)
    expect((await $.prompt.edit(key('', ';') as any)).text).toBe(';') // the leader alone lands as text
    const r = await $.prompt.edit(key(';', '2') as any)
    expect(r.text).toBe('Do the same for settings')
    expect(r.cursor).toBe('Do the same for settings'.length)
  })

  test('typing the leader arms the band: it shows the digits to press', async ($, on) => {
    engine(on, () => REPLY)
    await finishTurn($)
    await $.prompt.edit(key('', ';') as any)
    let ui = await band($)
    expect(await ui.find({ type: 'Text', text: /^press 1, 2 or 3 to draft it · 0 dismisses$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^0$/ })).toBeDefined()
    expect(JSON.stringify(await ui.drawn())).toContain('"borderColor":"warning"')
    await ui.unmount()
    await $.prompt.edit(key(';', 'x') as any) // anything else: back to the full keys
    ui = await band($)
    expect(await ui.find({ type: 'Text', text: /type ; then a number/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^;1$/ })).toBeDefined()
    await ui.unmount()
    ui = await band($, 160, 4) // the compact row arms too
    await $.prompt.edit(key('', ';') as any)
    await ui.unmount()
    ui = await band($, 160, 4)
    expect(await ui.find({ type: 'Text', text: /^✦ pick $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ 1 $/ })).toBeDefined()
    await ui.unmount()
  })

  test('the card: a rounded rose border, and each suggestion in its own color', async ($, on) => {
    engine(on, () => REPLY)
    await finishTurn($)
    const ui = await band($)
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('"borderStyle":"round"')
    expect(drawn).toContain('"borderColor":"#fb7185"')
    for (const c of ['#f472b6', '#a5b4fc', '#5eead4', '#f9a8d4', '#c7d2fe', '#99f6e4']) expect(drawn).toContain(c)
    await ui.unmount()
  })

  test('leaves the drawing to where-am-i once it hosts the card', async ($, on) => {
    engine(on, () => REPLY)
    on('state.get', { plugin: 'where-am-i', key: 'hosts' }, () => ({ value: { value: true, version: 1 } }))
    on('state.get', { plugin: 'where-am-i', key: 'recap' }, () => ({ value: { value: { goal: 'g', now: '', waiting: '', next: '' }, version: 1 } }))
    await finishTurn($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Suggested|✦ next/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /band below/ })).toBeDefined()
    await ui.unmount()
    expect((await $.prompt.edit(key(';', '1') as any)).text).toBe('Run the tests you just wrote') // the keys still work
  })

  test('tells where-am-i its leader', { options: { leader: ',' } }, async ($, on) => {
    engine(on, () => REPLY)
    const set: unknown[] = []
    on('state.set', { plugin: 'next-steps', key: 'leader' }, (_$: any, e: any, next: any) => (set.push(e.value), next(e)))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    expect(set).toEqual([','])
  })

  test('a bare digit in an empty prompt types as usual', async ($, on) => {
    engine(on, () => REPLY)
    await finishTurn($)
    expect((await $.prompt.edit(key('', '1') as any)).text).toBe('1')
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Run the tests/ })).toBeDefined() // still offered
    await ui.unmount()
  })

  test('the leader after other text, or another key after it, types as usual', async ($, on) => {
    engine(on, () => REPLY)
    await finishTurn($)
    expect((await $.prompt.edit(key('a;', '1') as any)).text).toBe('a;1')
    expect((await $.prompt.edit(key(';', 'x') as any)).text).toBe(';x')
  })

  test('another leader from /config', { options: { leader: ',' } }, async ($, on) => {
    engine(on, () => REPLY)
    await finishTurn($)
    expect((await $.prompt.edit(key(';', '1') as any)).text).toBe(';1')
    expect((await $.prompt.edit(key(',', '1') as any)).text).toBe('Run the tests you just wrote')
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /^,1$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a digit in a prompt with text types as usual', async ($, on) => {
    engine(on, () => REPLY)
    await finishTurn($)
    const r = await $.prompt.edit(key('fix bug ', '1') as any)
    expect(r.text).toBe('fix bug 1')
  })

  test('a pasted digit lands as text', async ($, on) => {
    engine(on, () => REPLY)
    await finishTurn($)
    const { key: _key, ...paste } = key('', '1')
    expect((await $.prompt.edit(paste as any)).text).toBe('1')
  })

  test('ignores a result that arrives after a prompt was sent', async ($, on) => {
    let release: (s: string) => void = () => {}
    const held = new Promise<string>(done => (release = done))
    engine(on, () => held)
    await finishTurn($, 't1')
    await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'user' } } as any)
    release(REPLY)
    await wait()
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Run the tests/ })).toBeUndefined()
    await ui.unmount()
  })

  test('skips subagent turns', async ($, on) => {
    const eng = engine(on, () => REPLY)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.turn.complete({ reason: 'answer', answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'x', agentId: 'a1' } as any)
    await wait()
    expect(eng.calls()).toBe(0)
  })

  test('a digit with no suggestion for it types as usual', async ($, on) => {
    engine(on, () => REPLY)
    await finishTurn($)
    expect((await $.prompt.edit(key(';', '7') as any)).text).toBe(';7')
  })

  test('the leader then 0 dismisses the list and empties the box', async ($, on) => {
    engine(on, () => REPLY)
    await finishTurn($)
    const r = await $.prompt.edit(key(';', '0') as any)
    expect(r.text).toBe('')
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Run the tests/ })).toBeUndefined()
    await ui.unmount()
    expect((await $.prompt.edit(key(';', '1') as any)).text).toBe(';1') // nothing left to pick
  })

  test('a submitted prompt clears the list', async ($, on) => {
    engine(on, () => REPLY)
    await finishTurn($)
    await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'user' } } as any)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Run the tests/ })).toBeUndefined()
    await ui.unmount()
  })

  test('hidden, with no model call, after a trivial turn', async ($, on) => {
    const eng = engine(on, () => REPLY)
    await finishTurn($, 't1', 'Done.')
    expect(eng.calls()).toBe(0)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Suggested|✦ next/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /band below/ })).toBeDefined()
    await ui.unmount()
  })

  test('hidden when the model has nothing to suggest', async ($, on) => {
    engine(on, () => '')
    await finishTurn($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Suggested|✦ next/ })).toBeUndefined()
    await ui.unmount()
  })

  test('tells where-am-i only while the list shows', async ($, on) => {
    engine(on, () => REPLY)
    const written: unknown[] = [] // what next-steps tells where-am-i, in order
    on('state.set', { plugin: 'next-steps', key: 'active' }, (_$: any, e: any) => {
      written.push(e.value)
      return { value: { isSet: true, version: written.length } }
    })
    on('state.get', { plugin: 'next-steps', key: 'active' }, () => ({ value: { value: written.at(-1), version: written.length } }))
    await finishTurn($)
    expect(written.at(-1)).toBe(true)
    await $.prompt.edit(key(';', '0') as any)
    expect(written.at(-1)).toBe(false)
  })

  test('waits while background agents still run', async ($, on) => {
    const eng = engine(on, () => REPLY, [{ id: 'a1', description: 'tests', type: 'general-purpose', status: 'running' }])
    await finishTurn($)
    expect(eng.calls()).toBe(0)
  })

  test('cleans the model lines', () => {
    expect(parseSteps('1. Run the tests.\n- Open a PR \u2014 draft\n\n* "Ship it"\nfour')).toEqual(['Run the tests', 'Open a PR, draft', 'Ship it'])
    expect(parseSteps('["a", "b"]')).toEqual(['a', 'b'])
    expect(parseSteps('```json\n["Run the tests", "Ship it"]\n```')).toEqual(['Run the tests', 'Ship it'])
    expect(parseSteps('{"prompts": ["Run it"]}')).toEqual(['Run it'])
    expect(parseSteps('Here are three follow-ups\n**Fix the 3 failing tests**\n3 failing tests need a look')).toEqual([
      'Fix the 3 failing tests',
      '3 failing tests need a look',
    ])
    expect(parseSteps('NONE')).toEqual([])
    expect(parseSteps('No follow-up needed')).toEqual([])
    expect(parseSteps('Here are some ideas:\nrun it\nRun it')).toEqual(['run it'])
    expect(parseSteps(`${'word '.repeat(30)}\nshort one`)).toEqual(['short one']) // too long: dropped, not cut
    expect(fitsOnOneLine(['a', 'b'], 40)).toBe(true)
    expect(fitsOnOneLine(['a'.repeat(40), 'b'.repeat(40)], 80)).toBe(false)
  })
})
