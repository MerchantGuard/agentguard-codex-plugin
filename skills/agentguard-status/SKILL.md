---
name: agentguard-status
description: Read today's AgentGuard decisions, configured spend, blocks, and fail-open events from the local signed ledger without changing policy or tools.
---

# AgentGuard status

Use the optional AgentGuard MCP server's `get_status` tool with `{}` for the
current UTC date, or `{"day":"YYYY-MM-DD"}` for a requested date. Identify
the timezone in the summary. The server reads the same Spend decision store
used by the hooks at `${PLUGIN_DATA}/ledger/decisions.ndjson`.

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
