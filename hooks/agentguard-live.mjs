// AgentGuard Live: a band above the prompt and a pane, drawn from what
// AgentGuard's gates decided. The band shows how close this session is to its
// sub-agent limits and its token limit, the share of tokens that went to
// sub-agents, and plan usage. The pane lists each launch, ask and stop in this
// session; every one is a signed row in AgentGuard's ledger.
// Nothing here decides or blocks. The plugin's settings hooks enforce, the
// same way in Codex and in Claude Code without mods; this module only reads,
// through runtime/mod-status.cjs, and draws.

const PANE = 'agentguard'
const REFRESH_MS = 20000
const TEAL = '#2abcb4'

let active = true            // false where nothing draws: claude -p, the VS Code panel
let sessionId = null
let status = null            // the last answer from runtime/mod-status.cjs
let failed = false           // the last refresh could not run
let verified = null          // { ok, rows, at } from the last signature check
let busy = false
let again = false
let againVerify = false
let stale = false            // a model request finished since the last refresh
let usage = null             // $.session.usage(), for plan limits
const live = { main: 0, sub: 0 }  // tokens per request since this session opened

function compact(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '0'
  const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  for (const [size, unit] of units) {
    if (n >= size) return (n / size).toFixed(n >= size * 10 ? 0 : 1).replace(/\.0$/, '') + unit
  }
  return String(Math.round(n))
}

function grouped(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function level(count, limit) {
  if (!limit) return 'ok'
  const ratio = count / limit
  return ratio >= 1 ? 'over' : ratio >= 0.7 ? 'near' : 'ok'
}

const COLOR = { ok: null, near: 'yellow', over: 'red' }

function clock(at) {
  const time = new Date(typeof at === 'number' && at < 1e12 ? at * 1000 : at)
  return isNaN(time.getTime()) ? '' : time.toTimeString().slice(0, 8)
}

const PLAN_NAMES = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet' }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function planName(kind) {
  return PLAN_NAMES[kind] || String(kind || 'plan').replace(/_/g, ' ')
}

// A reset later today shows its time; a later day shows the date too
function resets(at) {
  const time = new Date(typeof at === 'number' && at < 1e12 ? at * 1000 : at)
  if (isNaN(time.getTime())) return ''
  const hours = time.toTimeString().slice(0, 5)
  return time.toDateString() === new Date().toDateString() ? hours : MONTHS[time.getMonth()] + ' ' + time.getDate() + ', ' + hours
}

// The highest plan limit Claude Code reports, such as the five-hour one
function planUsed() {
  let best = null
  for (const limit of (usage && usage.rateLimits) || []) {
    if (typeof limit.percentUsed === 'number' && (!best || limit.percentUsed > best.percentUsed)) best = limit
  }
  return best
}

function subShare() {
  const total = live.main + live.sub
  return total > 0 && live.sub > 0 ? Math.round((100 * live.sub) / total) : null
}

// The window closer to its limit is the one the band leads with
function leading(burn) {
  const ratio = (w) => (w.limit ? w.count / w.limit : 0)
  return ratio(burn.sustained) > ratio(burn.burst) ? burn.sustained : burn.burst
}

function text(part) {
  const props = { children: [part.text] }
  if (part.color) props.color = part.color
  if (part.bold) props.bold = true
  if (part.dim) props.dimColor = true
  if (part.truncate) props.wrap = 'truncate-end'
  return props
}

// The band's pieces, in the order they're dropped from the end when the
// terminal is narrow. The name and the sub-agent count always stay.
function bandParts() {
  const parts = [{ text: 'AgentGuard', color: TEAL, bold: true }]
  const burn = status && status.burn
  if (!burn) {
    parts.push({ text: failed ? '  status unavailable · /agentguard' : '  starting', dim: true })
    return parts
  }
  const window = leading(burn)
  parts.push({ text: '  sub-agents ' + window.count + ' of ' + window.limit, color: COLOR[level(window.count, window.limit)] })
  parts.push({ text: ' · tokens ' + compact(burn.tokens.used) + ' of ' + compact(burn.tokens.limit), color: COLOR[level(burn.tokens.used, burn.tokens.limit)] })
  const share = subShare()
  if (share !== null) parts.push({ text: ' · ' + share + '% to sub-agents', dim: true })
  const plan = planUsed()
  if (plan) parts.push({ text: ' · ' + planName(plan.kind) + ' ' + Math.round(plan.percentUsed) + '%', color: plan.percentUsed >= 90 ? 'red' : plan.percentUsed >= 70 ? 'yellow' : null, dim: plan.percentUsed < 70 })
  if (burn.mode === 'shadow') parts.push({ text: ' · watching only', color: 'yellow' })
  parts.push({ text: ' · /agentguard', dim: true })
  return parts
}

function fit(parts, width) {
  const kept = []
  let used = 0
  for (const [i, part] of parts.entries()) {
    if (i > 1 && used + part.text.length > width) break
    kept.push(part)
    used += part.text.length
  }
  if (kept.length) kept[kept.length - 1] = { ...kept[kept.length - 1], truncate: true }
  return kept
}

const RESULT_COLOR = { 'stopped': 'red', 'asked you': 'yellow', 'allowed by you': 'green', 'flagged': 'yellow' }

function paneLines() {
  const lines = [{ text: 'This session', bold: true }]
  const burn = status && status.burn
  const ledger = status && status.ledger
  if (!burn && !ledger) {
    lines.push({ text: failed ? 'AgentGuard could not read its status. Run /agentguard again, or check that node is on your PATH.' : 'Reading AgentGuard\'s status…', dim: true })
    return lines
  }
  if (burn) {
    lines.push({ text: 'Sub-agents: ' + burn.burst.count + ' of ' + burn.burst.limit + ' in the last ' + burn.burst.windowActiveMinutes + ' active minutes', color: COLOR[level(burn.burst.count, burn.burst.limit)], truncate: true })
    lines.push({ text: '            ' + burn.sustained.count + ' of ' + burn.sustained.limit + ' in the last ' + burn.sustained.windowActiveMinutes + ' · ' + burn.spawns + ' in all', color: COLOR[level(burn.sustained.count, burn.sustained.limit)], truncate: true })
    lines.push({ text: 'Tokens: ' + compact(burn.tokens.used) + ' of the ' + compact(burn.tokens.limit) + ' session limit', color: COLOR[level(burn.tokens.used, burn.tokens.limit)] })
    lines.push({ text: burn.mode === 'shadow' ? 'Mode: watching only. Limits are recorded and nothing waits.' : 'Mode: at a limit, the next launch waits for your yes.', dim: burn.mode !== 'shadow', color: burn.mode === 'shadow' ? 'yellow' : null })
  }
  const share = subShare()
  if (share !== null) lines.push({ text: 'Since this session opened: ' + compact(live.main) + ' tokens in the main conversation, ' + compact(live.sub) + ' in sub-agents (' + share + '%)' })
  const plan = planUsed()
  if (plan) {
    const when = plan.resetsAt ? resets(plan.resetsAt) : ''
    lines.push({ text: 'Plan: ' + Math.round(plan.percentUsed) + '% of your ' + planName(plan.kind) + ' limit used' + (when ? ' · resets ' + when : ''), truncate: true })
  }
  lines.push({ text: ' ' })
  lines.push({ text: 'Launches, asks and stops, newest first (each one a signed row)', bold: true })
  const rows = (ledger && ledger.decisions) || []
  if (!rows.length) lines.push({ text: 'None in this session yet.', dim: true })
  for (const row of rows.slice(0, 12)) {
    lines.push({ text: clock(row.at) + '  ' + (row.tool || 'tool') + '  ' + row.result, color: RESULT_COLOR[row.result] || null, dim: !RESULT_COLOR[row.result], truncate: true })
  }
  lines.push({ text: ' ' })
  if (ledger) {
    const base = 'Ledger: ' + grouped(ledger.ledger.entries) + ' signed rows'
    if (verified && verified.ok) lines.push({ text: base + ' · signatures verified at ' + clock(verified.at).slice(0, 5), color: 'green', truncate: true })
    else if (verified && !verified.ok) lines.push({ text: base + ' · signature check FAILED', color: 'red', truncate: true })
    else lines.push({ text: base + ' · press v to verify the signatures', dim: true, truncate: true })
  }
  return lines
}

async function refresh($, verify) {
  if (!sessionId || !active) return
  if (busy) {
    again = true
    againVerify = againVerify || verify
    return
  }
  busy = true
  try {
    const argv = ['node', $.plugin.root + '/runtime/mod-status.cjs', '--session', sessionId]
    if (verify) argv.push('--verify')
    const run = await $.process.run(argv, { timeoutMs: 15000 })
    const answer = JSON.parse(run.stdout)
    if (answer && answer.ok) {
      status = answer
      failed = false
      const check = answer.ledger && answer.ledger.ledger
      if (check && check.verified !== null && check.verified !== undefined) verified = { ok: check.verified === true, rows: check.entries, at: answer.at }
    } else failed = true
    stale = false
  } catch {
    failed = true
  }
  busy = false
  $.ui.invalidate('ui.render')
  if (again) {
    const nextVerify = againVerify
    again = false
    againVerify = false
    await refresh($, nextVerify)
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    // AGENTGUARD_LIVE=0 turns the band and pane off; the gates enforce either way
    let setting = null
    try { setting = await $.env.get('AGENTGUARD_LIVE') } catch { setting = null }
    active = setting !== '0' && e.isInteractive !== false && (!e.surface || e.surface === 'terminal' || e.surface === 'desktop')
    await $.command.register({ name: 'agentguard', description: "Show AgentGuard's limits and signed decisions for this session", immediate: true })
    if (active) {
      try { sessionId = await $.session.id() } catch { sessionId = null }
      try { usage = await $.session.usage() } catch { usage = null }
      $.clock.every(REFRESH_MS, () => {
        if (stale) return refresh($, false)
      })
      await refresh($, false)
    }
    return next(e)
  })

  // A new session id after /clear, /resume or /branch; the counts start over
  on('classic.SessionStart', async ($, e, next) => {
    if (typeof e.session_id === 'string' && e.session_id !== sessionId) {
      sessionId = e.session_id
      live.main = 0
      live.sub = 0
      status = null
      verified = null
    }
    await refresh($, false)
    return next(e)
  })

  // After Claude Code decides a launch, so the band is current before any prompt shows
  on('tool.check', { tool: ['Task', 'Agent'] }, async ($, e, next) => {
    const decision = await next(e)
    await refresh($, false)
    return decision
  })

  // Each request's tokens, split between the main conversation and sub-agents
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const used = result && result.usage
    if (used) {
      const tokens = (used.input_tokens || 0) + (used.output_tokens || 0) + (used.cache_read_input_tokens || 0) + (used.cache_creation_input_tokens || 0)
      if (e.agentId) live.sub += tokens
      else live.main += tokens
      stale = true
      $.ui.invalidate('ui.render')
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) await refresh($, false)
    return result
  })

  on('session.measure', async ($, e, next) => {
    try { usage = await $.session.usage() } catch { /* keep the last reading */ }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('command.run', { command: 'agentguard' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'AgentGuard', focus: true, closeOnEscape: true })
    await refresh($, true)
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!active) return rest
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(24, ((e.props && e.props.bodyColumns) || 80) - 2)
    const line = Box({ flexDirection: 'row', children: fit(bandParts(), width).map((part) => Text(text(part))) })
    return rest ? Box({ flexDirection: 'column', children: [line, rest] }) : line
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      children: [
        ...paneLines().map((part) => Text(text(part))),
        Box({
          flexDirection: 'row',
          columnGap: 3,
          children: [
            Button({ key: 'refresh', label: 'Refresh', hotkey: 'r', plain: true, onPress: () => refresh($, false) }),
            Button({ key: 'verify', label: 'Verify signatures', hotkey: 'v', plain: true, onPress: () => refresh($, true) }),
            Button({ key: 'close', label: 'Close', hotkey: 'c', plain: true, onPress: () => $.ui.close({ id: PANE }) }),
          ],
        }),
      ],
    })
  })
}
