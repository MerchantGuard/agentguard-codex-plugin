# Claude Code adapter

The shared package adds Claude Code 2.1.275 without renaming its repository
or npm package. The runtime, license gate, skills, signing keys and ledger
format are shared code. Each host normally has its own plugin data directory.

## Released contract

Claude discovers `.claude-plugin/plugin.json`, `hooks/hooks.json`,
`.mcp.json` and the three `skills` directories at the package root. The
manifest does not repeat default component paths as additional sources.
The public `.claude-plugin/marketplace.json` selects that root. Codex keeps
its existing generated compatibility directory and hook source path.
[Plugin reference](https://code.claude.com/docs/en/plugins-reference).

Command hooks use the regular-expression matcher `.*`. A policy denial uses
`hookSpecificOutput` with `hookEventName: PreToolUse`,
`permissionDecision: deny` and a one-line `permissionDecisionReason`.
An admission returns an empty successful object, preserving Claude's own
permission checks. Internal failures also abstain and attempt to record a
fail-open event. Successful and failed calls have separate receipt events:
PostToolUse and PostToolUseFailure.
[Hook inputs and outputs](https://code.claude.com/docs/en/hooks).

## Payload normalization

The following mapping is exercised against stdin captured in a live 2.1.275
session. The committed fixture documents its deterministic redactions. Raw
capture files and authentication state are excluded from the distribution.

- `session_id`: Authoritative session identifier.
- `tool_name`: Recorded tool name and capability lookup.
- `tool_use_id`: Link a decision to its outcome.
- `tool_input`: Compute SHA256, serialized byte count and key count in memory.
- `transcript_path`: Pass the locator to Burn for local usage observation.
- `cwd`: Find an applicable standalone Burn hook.
- `hook_event_name`: Distinguish a failed tool from a successful receipt event.
- `tool_response`: Measure serialized output bytes without retaining output text.
- `agent_id`: Preserve the host's subagent identifier when present.
- `duration_ms`: Use a finite nonnegative host duration when provided.
- `error, is_interrupt`: Record failure from PostToolUseFailure without retaining error text.

Host-specific normalization lives in `runtime/common.cjs`. New metadata adds
`host` to the existing schema. Readers accept older rows without it and label
their host unknown. They do not rewrite or infer a host for an old signature.
Missing duration or Bash exit status is not inferred from output text.

The Bash process used by a skill does not inherit plugin variables just
because hooks do. Claude replaces exact plugin placeholders in skill text;
the documented helper commands pass those paths explicitly. The session
placeholder is passed explicitly too, so a different session's seat status
cannot authorize an export.
[Plugin variables](https://code.claude.com/docs/en/plugins-reference#environment-variables).

## Coverage and Burn coexistence

Bash, Read, Edit, Write and MCP calls reach the policy gates. Agent spawns
reach Burn; the older Task name remains supported. WebFetch and WebSearch
use the read_only minimum tier. Claude omits PreToolUse for EndConversation.
Disabled hooks, non-tool activity and a host crash can leave gaps. Codex
hosted tools have different coverage.
[PreToolUse coverage](https://code.claude.com/docs/en/hooks#pretooluse).

For a matching, recognized standalone Burn command, the plugin records
`burn_external_hook` and defers Burn accounting. This avoids a second spawn
reservation. That observation does not claim to know the external hook's
decision, receipt or policy mode. The plugin never disables another hook.

## Trust and test evidence

The live scratch workspace displayed “Quick safety check: Is this a project
you created or one you trust?” and offered “Yes, I trust this folder”. No
permission bypass was used. This observation concerns workspace trust; it
is not a claim that a marketplace installation was reviewed at that point.
Claude's `/hooks` menu is read-only and has no Codex-style per-hook hash trust
action. Review the source and use the normal marketplace installation flow.
[Installation](https://code.claude.com/docs/en/discover-plugins),
[Hooks menu](https://code.claude.com/docs/en/hooks#the-hooks-menu).

From a provisioned public source checkout, `npm run test:hosts` runs the full
suite twice. The host-facing hook, Burn, lifecycle, offline and recovery
tests switch to captured Claude payloads in the Claude run. Generic policy,
license and ledger tests run in both. Explicit Codex compatibility and trust
regressions continue testing Codex in both runs. No test retries a normal
decision through a fail-open result.
