---
name: agentguard-policy
description: Activate an AgentGuard license or edit tool policies for matter budgets, session allowlists, and ethical-wall denies when the operator requests it.
---

# AgentGuard policy

Use this skill for an operator-requested policy change. A blocked tool request
is not authorization to loosen its policy. Read the host's policy file first: `${PLUGIN_DATA}/policy.json` in Codex,
or `${CLAUDE_PLUGIN_DATA}/policy.json` in Claude Code. Use the packaged
default when it is absent. A paid session can also
load a team file from `AGENTGUARD_PLUGIN_POLICY` or the local `teamPolicyFile`
field; relative paths resolve from the host plugin data directory. Preserve the local license
key while editing shared rules. Do not modify Burn's policy unless the user
separately requests it.

## Add a key for Solo or Team

For the operator request `activate license <KEY>`, choose the command for the
current host below. Supply the key through standard input. Never place it in
command arguments, echo it, print it, or add it to a ledger entry. The helper
writes `licenseKey` into the host's `policy.json`, preserves unrelated fields,
and resolves the license again outside the hook process. Do not reproduce
the key in the completion message.

### Codex activation

```sh
PLUGIN_ROOT="${PLUGIN_ROOT}" PLUGIN_DATA="${PLUGIN_DATA}" node "${PLUGIN_ROOT}/runtime/activate.cjs"
```

Pass the known host session ID as an optional positional argument. Otherwise
the helper uses `CODEX_THREAD_ID` when available. Do not invent an ID or pass
the license key as that argument.

### Claude Code activation

```sh
CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID}" node "${CLAUDE_PLUGIN_ROOT}/runtime/activate.cjs" "${CLAUDE_SESSION_ID}"
```

Claude Code substitutes those exact placeholders when loading this skill.
Its Bash tool does not inherit the plugin variables, so retain the explicit
environment assignments. Use only the current host's command. If its paths
or session ID remain unresolved, identify them from the installed plugin and
current host context before running the helper; never use an empty path or
guess a data directory. The Codex placeholders in the other command do not
apply to Claude Code.

`AGENTGUARD_LICENSE_KEY` takes precedence over the policy field. If that
environment variable selects a different key, explain the precedence without
revealing either key. Report the returned tier, seats used and limit, expiry,
effective mode, and reason. An unavailable value is unknown, not zero.

Free uses the local policy, default enforce, on one machine without a key or
account. It includes local signed receipts and Burn. Add a key for Solo or Team:
Solo adds up to three machines, the dashboard, receipts export and email support;
Team adds ten seats and org policy. Team is the only trial, with a card.
Existing Growth and Pro keys remain supported. A policy requesting shadow
remains shadow. A configured invalid or expired key selects shadow with
`license_required`; an exceeded seat limit selects shadow with `seat_limit`.
These failures retain their reasons and never gain Free enforcement. Licensing
never denies a tool call. Shadow is a fallback state, not the Free tier.

## Edit policy

1. Identify the requested matter/session/agent identifiers from the operator's
   instructions. Use identifiers only; do not copy document contents,
   provider credentials, client names, prompts, or tool inputs into policy.
   The activation helper's `licenseKey` field is the sole credential exception.
2. Preserve existing policy fields and unrelated sessions. Patterns are
   JavaScript regular expressions; anchor exact names. Denies and ethical
   walls are explicit restrictions, independent of monetary caps.
3. Make the requested edit, validate the resulting JSON and pattern syntax,
   then show the changed rules and their effect with synthetic tool names.
   An invalid policy fails open, so do not leave a partially written file.
4. Explain that unpriced tools cost zero in this ledger and that hook coverage
   excludes Codex hosted tools and specialized paths. Claude Code WebSearch
   and WebFetch use its tool hooks. Recommend protecting policy
   files from agent writes when the firm uses them as controls.

Use `get_status` to check the effective mode before describing an edited rule
as enforced. Set `teamPolicyFile` to share a policy file across paid sessions;
relative paths resolve from the host plugin data directory. Free sessions use the local policy
instead. In shadow fallback mode,
the operator can review signed decisions, but an allowlist, cap or ethical
wall does not block a tool call.

## Per-matter budget example

These amounts are example configuration, not measured service prices. Merge
this cap into `caps`; `defaultMatterId` or `sessions[sessionId].matterId`
becomes the decision's `actor.taskId`:

```json
{
  "defaultMatterId": "matter-example",
  "toolRules": [
    {"pattern": "^mcp__imanage__save_document$", "capability": "data_write", "unitCostCents": 2}
  ],
  "caps": [
    {"selector": {"taskId": "matter-example"}, "window": "per_day", "amountCents": 500, "action": "block"}
  ]
}
```

Other exact-match selectors include `agentId` and `sessionId`. Global and
session caps apply together. Use the actual operator-assigned IDs, not tool
input fields that the agent can invent. A host with no agent identity uses
the operator's session mapping or session ID fallback.

## Document-review session allowlist

Merge the session into `sessions`. This example permits document reads and
planning but excludes writes by omission and by capability tier:

```json
{
  "sessions": {
    "session-example": {
      "matterId": "matter-example",
      "maxCapability": "read_only",
      "allowedTools": ["^mcp__imanage__(search_documents|read_document)$", "^update_plan$"],
      "deniedTools": ["^Bash$", "^(apply_patch|Edit|Write)$"]
    }
  }
}
```

Add read-only AgentGuard MCP tool patterns if the operator wants status and
verification tools available in this session. Do not silently exempt any
plugin's tools from an allowlist.

## Ethical-wall deny list

An ethical wall is a list of tool-name patterns denied for the current
session. It does not inspect document contents or infer professional
conflicts. Configure separate service-side access controls as needed:

```json
{
  "sessions": {
    "session-example": {
      "ethicalWall": ["^mcp__restricted_matter__.*$", "^mcp__imanage__cross_matter_search$"]
    }
  }
}
```

Preserve any existing global wall. Report the edited file, relevant rules,
validation performed, and the fail-open consequence of runtime errors.
