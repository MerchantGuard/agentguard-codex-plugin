# Launch depth and helper models

Both features are off by default. Count limits remain 15 launches in 15 active
minutes, 40 in 120 active minutes, and 5 billion session tokens. A helper launch
does not change the main session's model or an agent already running.

Run the policy CLI from the installed plugin root with the host's plugin data
environment, as shown in the policy skill. These settings stay on this machine;
the current Solo and Team sync contract does not upload them.

```sh
node runtime/policy-cli.cjs preset copies-ask
node runtime/policy-cli.cjs set-depth 2
node runtime/policy-cli.cjs helper-model 100000 haiku search,logs logs
node runtime/policy-cli.cjs show
```

The named preset is **Copies ask before launching copies**. It changes only
`max_depth` to 1. A main-session launch is depth 1, a copy's launch is depth 2,
and that copy's launch is depth 3. A launch strictly past the limit pauses.
Claude Code also has its own nesting limit: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`
defaults to three layers. At that limit the host withholds the Agent tool.
AgentGuard checks the launch before it starts, requests your approval instead
of withholding the tool, and writes a signed receipt. Its own limit never
raises Claude Code's limit. Codex uses the same AgentGuard policy and receipts;
where reliable lineage is unavailable, the count limit applies and depth is
recorded as unknown.

Use `set-depth off` or `helper-model off` to disable the corresponding setting.

Equivalent local policy fields:

```json
{
  "version": 1,
  "mode": "enforce",
  "max_depth": 1,
  "helper_models": {
    "enabled": true,
    "token_budget": 100000,
    "helper_types": ["search", "logs"],
    "keep_types": ["logs"],
    "model": "haiku"
  }
}
```

Routing starts strictly above the recorded budget. Names match exactly and the
keep list wins. In this example only search changes. The operator selects the
smaller model; AgentGuard does not infer price or capability from a model name.
Session-specific mappings use the same fields inside `sessions[session_id]`.
The stricter global or session depth applies. A session routing override cannot
remove a globally kept type. Shadow mode records proposed changes and applies
neither a depth hold nor a model rewrite.

## Host findings, checked October 5, 2026

| Host | Depth | Launch model input |
| --- | --- | --- |
| Claude Code 2.1.289 | Reuses hook `agent_id` and that caller's local `.meta.json` `spawnDepth`. A documented absent caller ID identifies the main session. Missing or malformed copy metadata uses count limits. | Agent and Task accept `model`. `updatedInput` replaces the whole input. Live canary changed sonnet to haiku. Fork launches use a suggestion. |
| Codex CLI 0.160.0, Node 22.17.1 | Caller IDs were observed, but there is no verified depth. The receipt records null and the count limit applies. | Live `collaborationspawn_agent` accepted `updatedInput.model` with `permissionDecision: allow`. `fork_turns: none` changed gpt-6-sol to gpt-6-luna. Full-history forks and uncertain custom roles use a suggestion. |
| ChatGPT desktop local tasks | Same fallback when depth is unavailable. | No desktop canary was run. Desktop behavior remains unverified. |

Claude Code requests the person's answer in its native permission prompt. In
print mode that request cannot be answered; the canary recorded a permission
denial and no nested launch. In other modes without a prompt, AgentGuard holds
the launch until operator approval. Codex receives a denial, never an ask
decision. Its operator can use `pending` and `approve <token>` in their own
terminal, then retry the exact call within five minutes. Tokens bind session,
input, caller, depth and policy. An approval cannot override a separate count
limit or guard rule. Agent-issued approval and policy changes remain blocked.

When a selected model cannot be applied, the permission reason suggests that
model. Approval allows the original launch; it does not claim a model change.
Claude keeps native permission checks when a launch is otherwise allowed.
Codex's documented rewrite contract requires an explicit allow.

The observed Codex collaboration schema has no helper role field. Such launches
have the explicit policy type `default`. Listing `search` does not match a
task merely named search. Opting into `default` applies to untyped helpers;
keeping `default` excludes all of them. No task name or prompt is read to infer
a role. A Codex role configuration can override a requested model, so detected
custom role files select the suggestion path conservatively.

Sources: [Claude hook inputs and decisions](https://code.claude.com/docs/en/hooks),
[Claude subagents](https://code.claude.com/docs/en/sub-agents),
[Codex hook coverage and rewrites](https://learn.chatgpt.com/docs/hooks), and
[Codex subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents).
Installed tool schemas and live output narrow these documentation claims.

## Accounting, receipts and privacy

Spend's existing capability checks and downgrade evaluator make the routing
decision. This is launch admission with zero inference charge, not a billed
model call. The receipt records caller, known depth, limit, decision, models,
budget, observed tokens and reason. An outcome links to the admission. A signed
rewrite decision records what the hook requested; it is not proof that a host
ran a model. The canary additionally observed the running helper model.

Claude usage comes from Burn's incremental session reader. Burn alone owns the
Codex cumulative token parser and the stable replacement identity, regardless
of whether helper routing is enabled. Repeated hooks, legacy per-call rows,
cumulative snapshots and restarts share this accounting. Cached input is
already included in the Codex total. The plugin and Burn also share one launch
tool recognizer, including the observed collaboration aliases.

Codex usage has estimated coverage of the transcript delivered to a hook. It
does not guarantee every child thread's usage is included. Work receipts label
these totals `tokenCoverage: estimated`; unknown usage remains absent. Tree can
include separately discovered child transcripts and therefore show more tokens
than the session's signed tally. Routing never estimates missing usage.

Resumed activity gets a fresh cumulative signed summary linked to the previous
summary. A repeated SessionEnd with no changes stays idempotent. Explicit
`agent_id`, `agent_type` and caller `depth` travel with launch receipts; unknown
values are null. `launch.depth` describes the proposed child.

With a standalone Claude Burn hook installed, that hook alone reserves count
admission. Burn 0.4.0 signs the host call ID. The plugin verifies its public key,
session chain and stored chain head before signing the governing admission,
then links the host outcome to it. Old or incomplete standalone receipts cannot
be turned into approvals and leave the tally unavailable. No unsigned log is
used to reconstruct a verdict.

Launch enforcement runs locally. Only bounded identifiers, counts and hashes enter
receipts or worker metadata. Complete replacement input is assembled in the
short-lived hook and returned to the host on this machine. Prompts, code, files
and tool outputs are not sent to AgentGuard. Errors use the existing fail-open
warning and recovery receipt path; unavailable storage can delay a signed
receipt until recovery. Existing definite guard denials retain their behavior.

## Branch verification and release order

The integration uses Spend 0.21.0, plugin 0.4.0 and Burn 0.4.0. From the
monorepo root, under Node 22, prepare unpublished local packages with:

```sh
node scripts/prepare-oct5-release.cjs
```

Then run each package's tests. The maintainer canary
`packages/agentguard-codex-plugin/scripts/canary-launch-policy.cjs`, kept in the
source repository and not shipped in the public plugin, runs either `claude` or `codex` in a scratch directory under `~/dev`, with at
most six launches. `scripts/collect-oct5-proof.cjs` at the monorepo root reads
its real signed receipts and generates tree, tally and a counts payload locally.
It does not call the Team transport.

Publish order for the release owner is Spend, plugin, Burn, then the unscoped
wrapper. All four packages must be available before recommending installation.
No publication is part of this integration.
