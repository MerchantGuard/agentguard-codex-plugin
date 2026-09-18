---
name: agentguard-policy
description: Author or edit AgentGuard tool policies for matter budgets, session allowlists, and ethical-wall denies when the operator requests a policy change.
---

# AgentGuard policy

Use this skill for an operator-requested policy change. A blocked tool request
is not authorization to loosen its policy. Read the active policy first:
`AGENTGUARD_PLUGIN_POLICY`, otherwise `${PLUGIN_DATA}/policy.json`, otherwise
the plugin's `config/default-policy.json`. Do not modify Burn's policy unless
the user separately requests it.

1. Identify the requested matter/session/agent identifiers from the operator's
   instructions. Use identifiers only; do not copy document contents,
   credentials, client names, prompts, or tool inputs into policy.
2. Preserve existing policy fields and unrelated sessions. Patterns are
   JavaScript regular expressions; anchor exact names. Denies and ethical
   walls are explicit restrictions, independent of monetary caps.
3. Make the requested edit, validate the resulting JSON and pattern syntax,
   then show the changed rules and their effect with synthetic tool names.
   An invalid policy fails open, so do not leave a partially written file.
4. Explain that unpriced tools cost zero in this ledger and that hook coverage
   excludes hosted tools and specialized paths. Recommend protecting policy
   files from agent writes when the firm uses them as controls.

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
