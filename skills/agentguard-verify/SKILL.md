---
name: agentguard-verify
description: Verify the AgentGuard signed chain on any tier and, with a valid paid license, export a content-free receipt bundle to an operator-authorized location for a records custodian.
---

# AgentGuard verify

Prefer the read-only MCP tools. For `get_status` and `export_receipts`,
include the known host session ID on every call, including each export page.
Claude Code supplies `${CLAUDE_SESSION_ID}` in this skill; Codex may supply
`CODEX_THREAD_ID`. Do not use another session's entitlement or invent an ID.

1. Call the optional AgentGuard MCP server's `verify_chain` tool with `{}`.
   Report signature and chain failures exactly; never repair or truncate a
   ledger to produce a passing verification. Verification remains free.
2. For a requested export, use `get_status` to check paid eligibility. A valid
   Solo, Startup or Growth license, including Pro variants, permits export.
   If unavailable, report `license_required` or `seat_limit` as returned and
   keep the verification result. Do not reconstruct an export through
   `list_decisions` or direct ledger reads to bypass the export gate.
3. Call `export_receipts` starting at `fromSequence: 0`. Its read-only response
   is a JSON page with format `agentguard-signed-receipts-v1`, `publicKeyHex`,
   `verified`, `complete`, `entries`, `nextSequence`, `totalEntries`, and
   `lastEntryHash`. Follow `nextSequence` until the complete chain is included.
4. Preserve entry ordering, hashes, signatures, and verification metadata.
   A partial page is not a complete chain export. If the ledger grows during
   export, identify the final included sequence and hash and verify that
   precise exported prefix before describing it as verified.
5. When the user requests a file export, write the returned bundle only to
   their authorized destination. The MCP server does not write files. Do not
   send the bundle to email, chat, storage services, or another person unless
   the user explicitly requested that destination/action.
6. Include the verification public key and advise retaining its fingerprint
   separately through a trusted channel. Never export the signing private
   key, tool inputs, output text, transcripts, or document bodies.

## Local helper when MCP is disabled

Choose the current host's command. Verification stays free. For an authorized
paid export, append `export RECEIPTS_FILE`, replacing `RECEIPTS_FILE` with the
operator's destination. The helper checks that session's local license state
and writes the signed bundle only when eligible. Neither verification path
refreshes the license over the network.

### Codex verification

```sh
PLUGIN_ROOT="${PLUGIN_ROOT}" PLUGIN_DATA="${PLUGIN_DATA}" node "${PLUGIN_ROOT}/runtime/verify.cjs"
```

Preserve `CODEX_THREAD_ID` when available. If it is unavailable, obtain the
current session ID before exporting and pass it as that environment variable.

### Claude Code verification

```sh
CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID}" node "${CLAUDE_PLUGIN_ROOT}/runtime/verify.cjs"
```

Claude Code substitutes those exact placeholders when loading this skill.
Bash does not inherit the plugin variables; retain the explicit assignments.
Do not run either host's command with empty or unresolved paths. Identify the
installed plugin root, data directory and current session before an export.

The bundle can be checked independently with the published Spend SDK's
`verifyChain`. A valid signature proves the records match the retained key;
it does not independently identify the key holder, establish completeness
outside the recorded prefix, or prove a tool outcome was correct. Distinguish
signed fail-open events and missing post-tool outcomes from successful calls.

Report the exported date/sequence range, entry count, last hash, verification
result, destination, and any missing records or unavailable components. If
MCP is disabled or verification cannot run, say so and do not claim success.
