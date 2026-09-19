---
name: agentguard-status
description: Read AgentGuard license tier, seat counts and verification status, expiry, effective mode, today's signed decisions, configured spend, blocks, and rolling fail-open counts and rates without changing policy or tools.
---

# AgentGuard status

Use the optional AgentGuard MCP server's `get_status` tool with `{}` for the
current UTC date, or `{"day":"YYYY-MM-DD"}` for a requested date. Identify
the timezone in the summary. The server reads the same Spend decision store
used by the hooks at `${PLUGIN_DATA}/ledger/decisions.ndjson`.

Include the known host `sessionId` in the tool arguments when available so
the returned license state belongs to that session. Do not invent an ID.

Report the license tier, `seatsUsed`, `seatLimit`, `seatStorage`,
`seatsVerified`, expiry, effective mode, and reason from the returned `license`
object. Include offline grace or unavailable seat registration when reported.
A `kv` response with `seatsVerified: true` is a validated shared count across
machines over the service's fifteen minute active window. Its storage key has
a twenty four hour lifetime renewed by heartbeats. It is still an observation
at a point in time, not a guarantee about future activity.

Label `memory` counts as unverified. They do not establish shared occupancy
across machines. If storage is unknown or `seatsVerified` is false, do not
claim a verified seat total. A retained numeric count after a failed heartbeat
is an earlier observation; preserve that qualification. Report
`seatRefreshedAt` as the last well-formed seat response time when available.
`seatHeartbeatAt` identifies the latest heartbeat attempt; a failure can update
that field while the count and its response time remain unchanged. Report
`seatHeartbeatError` as a reason code when present. Do not show the
license key. Unknown seats or expiry must stay unknown; do not infer them from
ledger activity. A paid license permits enforcement but does not override a
policy set to shadow.

The worker sends bounded heartbeats every five minutes for live sessions.
Those calls happen outside hook processes and do not delay a tool decision.
Heartbeats stop on `SessionEnd` or identified host process exit. When the host
process cannot be identified, recent tool activity renews a fifteen minute
lease; the worker does not renew an orphaned session indefinitely.
A failed heartbeat or later over-limit response does not change the current
session's effective mode. Startup still selects shadow when its seat check
reports an exceeded limit. Status reads make no network request.

Explain `license_required` as free shadow mode: decisions are signed and
recorded, but no tool call is blocked. Explain `seat_limit` as shadow mode
because the license's active seat limit was exceeded. These reason codes
are not tool denials. License refresh happens once per session outside the
hooks, with a two second timeout. Previously valid cached status can remain
usable offline for seven days after its expiry. Status reads do not refresh
the license, register a seat or send a heartbeat.

Use `list_decisions` with `fromSequence` and `limit` to inspect the relevant
entries when a total or failure needs explanation. Follow the returned
pagination cursor. Do not modify the ledger, policy, or signing key. If the
server is disabled or the ledger cannot be read, state that limitation;
do not treat unavailable records as zero activity.

Summarize decisions, allowed calls, blocks, configured spend in cents,
signed fail-open events, and recorded outcomes. Report
`pendingFailOpenEvents` separately with `pendingRecoveryStatus`: the pending
queue is unsigned/unverified, covers all dates, and can contain recovery
duplicates. Do not add it to the verified daily failure count. Separate observations from gaps:
an interrupted tool may have a pre-tool decision with no post-tool receipt.
Do not describe configured unit-cost accounting as a provider invoice or
report a verification success without calling `verify_chain`.

Explain fail-open entries with their recorded reason codes, without adding
input/output contents. Tool names, hashes, byte counts, actor identifiers,
and decision metadata are sufficient. Do not read tool transcripts or
document bodies to enrich the report.

Report only local hook coverage. Hosted tools, skipped/untrusted hooks,
specialized paths, and logging failures can leave activity outside the
ledger. No records is not proof that no tool ran.

Report `health.lastHour` and `health.sinceStart`: fail-open count, total gate
hook invocations, rate as a percentage, and known cause counts. Name the worker
start time. The denominator includes each PreToolUse gate invocation, including
a gate that passes the tool through to the other gate. PostToolUse receipt
observations are reported separately under `health.postToolUse`. A timeout
and its late worker response share one observation; a timeout wins.

If either rate exceeds 5 percent, print `health.warning` as one plain
line, including the known cause. These counters are unsigned operational
observations. They supplement the signed audit chain and must not be presented
as signed decisions. Pending timeout observations may be visible before the
worker recovers their signed audit rows. Do not add them again to these rates.

When `health.denominatorComplete` is false, describe the denominator as partial.
The ledger fallback cannot count pass-through hook invocations that had no
decision row. A missing worker start is unknown, not the start of the day.
If `health.truncated` is true, state that the bounded rolling record limit was
reached. Report `integrityEvents` separately from tool decisions and spend.
