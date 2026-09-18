---
name: agentguard-status
description: Read AgentGuard license tier, seats, expiry, effective mode, and today's signed decisions, configured spend, blocks, and fail-open events without changing policy or tools.
---

# AgentGuard status

Use the optional AgentGuard MCP server's `get_status` tool with `{}` for the
current UTC date, or `{"day":"YYYY-MM-DD"}` for a requested date. Identify
the timezone in the summary. The server reads the same Spend decision store
used by the hooks at `${PLUGIN_DATA}/ledger/decisions.ndjson`.

Include the known host `sessionId` in the tool arguments when available so
the returned license state belongs to that session. Do not invent an ID.

Report the license tier, seats used and seat limit, expiry, effective mode,
and reason from the returned `license` object. Include offline grace or unavailable seat
registration when reported. Do not show the license key. Unknown seats or
expiry must stay unknown; do not infer them from ledger activity. A paid
license permits enforcement but does not override a policy set to shadow.

Explain `license_required` as free shadow mode: decisions are signed and
recorded, but no tool call is blocked. Explain `seat_limit` as shadow mode
because the license's active seat limit was exceeded. These reason codes
are not tool denials. License refresh happens once per session outside the
hooks, with a two second timeout. Previously valid cached status can remain
usable offline for seven days after its expiry. Status reads do not refresh
the license or register a seat.

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
