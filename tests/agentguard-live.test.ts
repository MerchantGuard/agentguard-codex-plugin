// AgentGuard Live, the mod in hooks/agentguard-live.mjs: the band and the pane
// draw what runtime/mod-status.cjs reports, the mod never decides anything, and
// it does no work where nothing draws. Run with `claude plugin test`.
import { expect, mock, test } from 'claude-code/testing'

const STATUS = {
  v: 1, ok: true, sessionId: 'abc123', at: '2026-10-01T19:00:00.000Z',
  burn: {
    mode: 'enforce',
    burst: { count: 9, limit: 15, windowActiveMinutes: 15, enforced: true },
    sustained: { count: 22, limit: 40, windowActiveMinutes: 120 },
    tokens: { used: 1_200_000_000, limit: 5_000_000_000 },
    spawns: 31, running: 1, seen: true,
  },
  ledger: {
    license: { tier: 'free', paid: false, mode: 'enforce' },
    ledger: { entries: 1052, verified: true, signer: 'fbe6879b5757956f' },
    recorded: 40, asked: 1, stopped: 1,
    decisions: [
      { sequence: 1051, at: '2026-10-01T18:59:00.000Z', tool: 'Agent', result: 'asked you', reason: 'burn_stop' },
      { sequence: 1049, at: '2026-10-01T18:58:00.000Z', tool: 'Bash', result: 'stopped', reason: 'guard_pack' },
      { sequence: 1043, at: '2026-10-01T18:57:00.000Z', tool: 'Task', result: 'started', reason: 'burn_ok' },
    ],
  },
}

const BAND = {
  plugin: 'agentguard', component: 'AbovePrompt', surface: 'terminal',
  viewport: { columns: 140, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 130, scroll: { offset: 0, bodyRows: 1 }, view: {} },
} as const

const PANE = {
  plugin: 'agentguard', component: 'Pane', requestId: 'agentguard', surface: 'terminal',
  viewport: { columns: 140, rows: 40 },
  props: { title: 'AgentGuard', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function withStatus(on: any, status: any, runs: string[][] = []) {
  mock.clock(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'abc123' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200000, percent: 0 }, rateLimits: [{ kind: 'five_hour', percentUsed: 54, resetsAt: '2026-10-01T20:40:00.000Z' }], cost: 0 } }))
  on('process.run', ($: any, e: any) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: JSON.stringify(status), stderr: '' } }
  })
  // What Claude Code and later mods would draw in the band
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return runs
}

test('the band shows the sub-agent count, tokens and plan use, and keeps what other mods draw', async ($, on) => {
  const runs = withStatus(on, STATUS)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(runs[0].slice(-2)).toEqual(['--session', 'abc123'])
  expect(runs[0][1]).toMatch(/runtime\/mod-status\.cjs$/)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'AgentGuard' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sub-agents 9 of 15/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /tokens 1\.2B of 5B/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5-hour 54%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  await ui.unmount()
})

test('the window closer to its limit leads, in yellow near the limit', async ($, on) => {
  const near = structuredClone(STATUS)
  near.burn.burst.count = 3
  near.burn.sustained.count = 39
  withStatus(on, near)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount(BAND)
  const lead = await ui.find({ type: 'Text', text: /sub-agents 39 of 40/ })
  expect(lead?.props.color).toBe('yellow')
  await ui.unmount()
})

test('at the limit the count is red', async ($, on) => {
  const full = structuredClone(STATUS)
  full.burn.burst.count = 15
  withStatus(on, full)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /sub-agents 15 of 15/ }))?.props.color).toBe('red')
  await ui.unmount()
})

test('a narrow terminal keeps the name and the count and drops the rest', async ($, on) => {
  withStatus(on, STATUS)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 34 } })
  expect(await ui.find({ type: 'Text', text: /sub-agents 9 of 15/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5-hour/ })).toBeUndefined()
  await ui.unmount()
})

test('when the status cannot be read, the band says so instead of showing numbers', async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'abc123' }))
  on('session.usage', () => ({ deny: 'not in this test' }))
  on('process.run', () => ({ deny: 'node is not installed' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /status unavailable/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sub-agents \d/ })).toBeUndefined()
  await ui.unmount()
})

test('where nothing draws, such as claude -p, the mod runs nothing', async ($, on) => {
  const runs = withStatus(on, STATUS)
  await $.session.start({ surface: 'terminal', isInteractive: false, cwd: '/work' })
  const ui = await $.ui.mount(BAND)
  expect(runs.length).toBe(0)
  expect(await ui.find({ type: 'Text', text: 'AgentGuard' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  await ui.unmount()
})

test('AGENTGUARD_LIVE=0 turns the band off and runs nothing', async ($, on) => {
  const runs = withStatus(on, STATUS)
  mock.env(on, { AGENTGUARD_LIVE: '0' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount(BAND)
  expect(runs.length).toBe(0)
  expect(await ui.find({ type: 'Text', text: 'AgentGuard' })).toBeUndefined()
  await ui.unmount()
})

test('requests by sub-agents count toward their share of the tokens', async ($, on) => {
  withStatus(on, STATUS)
  on('turn.step', async function* ($: any, e: any) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: e.agentId ? 300 : 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  for (const agentId of [undefined, 'sub-1']) {
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1, ...(agentId ? { agentId } : {}) })
    let step = await stream.next()
    while (step.done !== true) step = await stream.next()
  }
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /75% to sub-agents/ })).toBeDefined()
  await ui.unmount()
})

test('/agentguard opens the pane with the signed rows and verifies the signatures', async ($, on) => {
  const runs = withStatus(on, STATUS)
  const opened: any[] = []
  const closed: any[] = []
  on('ui.open', ($: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.close', ($: any, e: any) => { closed.push(e); return { value: undefined } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'agentguard', args: '' })
  expect(opened[0].id).toBe('agentguard')
  expect(runs.at(-1)).toContain('--verify')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /9 of 15 in the last 15 active minutes/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Agent {2}asked you/ }))?.props.color).toBe('yellow')
    expect((await ui.find({ type: 'Text', text: /Bash {2}stopped/ }))?.props.color).toBe('red')
    expect(await ui.find({ type: 'Text', text: /1,052 signed rows · signatures verified/ })).toBeDefined()
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'close' })
    await ui.unmount()
  }
  expect(closed.length).toBe(2)
})

test('a sub-agent launch refreshes the counts once Claude Code has decided it, and the decision passes through unchanged', async ($, on) => {
  const runs = withStatus(on, STATUS)
  on('tool.check', () => ({ decision: 'ask' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const before = runs.length
  const decision = await $.tool.check({ tool: 'Agent', description: 'x', prompt: 'p' })
  expect(decision).toMatchObject({ decision: 'ask' })
  expect(runs.length).toBe(before + 1)
})

test('after /clear the new session id is the one read', async ($, on) => {
  const runs = withStatus(on, STATUS)
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ session_id: 'after-clear', source: 'clear', hook_event_name: 'SessionStart' })
  expect(runs.at(-1)?.slice(-2)).toEqual(['--session', 'after-clear'])
})
