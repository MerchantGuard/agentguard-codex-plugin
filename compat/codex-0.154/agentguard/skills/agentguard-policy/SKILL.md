---
name: agentguard-policy
description: Customize AgentGuard with local presets, spending caps, command rules and rule explanations. Push a personal policy to Solo machines or activate a license when the operator requests it.
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
Solo adds your policy synced to up to three machines, the dashboard, receipts export and email support;
Team adds org policy and seats from three people. Team is the only trial, with a card.
Existing Growth and Pro keys remain supported. A policy requesting shadow
remains shadow. A configured invalid or expired key selects shadow with
`license_required`; an exceeded seat limit selects shadow with `seat_limit`.
These failures retain their reasons and never gain Free enforcement. Licensing
never denies a tool call. Shadow is a fallback state, not the Free tier.

## Customize with commands

Use `runtime/policy-cli.cjs`, not hand-edited JSON, for the supported changes.
Resolve the current host paths first. Keep the explicit host environment
assignments shown in activation when running the policy CLI, including the
Claude session ID. Replace only `runtime/activate.cjs` with
`runtime/policy-cli.cjs` and its arguments. Do not send a license key as an argument.

1. Run `show` to explain the effective policy and whether it is local or synced.
2. Map the operator's request to one command below. Patterns are JavaScript
   regular expressions matched against shell command text, not tool names.
   Quote them as literal shell arguments. Never interpolate untrusted text.
3. Read the printed before and after diff. Each write is validated and atomic.
   The license key and unrelated local settings are preserved.
4. Run `show` again and use `get_status` for the actual host session before
   claiming that a rule is enforced. With Solo, changes remain local until push.

- Usual defaults: `preset solo-dev`.
- Careful destructive work: `preset careful`.
- Ask before network, deploy or publish: `preset strict`.
- Limit to 15 dollars a day: `set-cap 15 per_day`.
- Limit each session to 5 dollars: `set-cap 5 per_session`.
- Block git push to main: `block '\bgit\s+push\b[^;\n]*\bmain\b'`.
- Allow a command pattern: `allow '<the same literal pattern>'`.
- Explain the inbox guard: `explain inbox-reset-codes`.
- Put the policy on Solo machines: `push`.
- Dismiss local upgrade moments permanently: `quiet on`.

Presets replace mode, caps, command rules and guard settings. They preserve
other fields, including configured tool prices, sessions and licensing.
The careful preset blocks force pushes, recognized deploy commands and rm
outside the workspace, with a $15 daily cap. Strict sets a $5 daily cap and
asks for network, deploy and package publish. Because a shell or connector
can open the network without declaring it, strict asks for every shell and
connector call. The exact packaged local show, explain, quiet and approval helper
remain usable. It also retains the force push and outside-workspace rm blocks.
Both presets enable `inbox-reset-codes`; solo-dev leaves it off.

Last matching command rule wins within its layer. An allow cannot weaken
built-in Guard Pack rules or a Team administrator's restrictions. Explain
that distinction when a tool remains blocked. The git example covers explicit
main arguments; default-branch pushes and aliases need separate rules.
Do not invent coverage for arbitrary programs or shell aliases.

Caps count configured tool unit prices, not provider bills. Unpriced tools
count as zero. Daily windows use UTC; session windows use the host session ID
and survive worker restarts. Hook coverage excludes Codex hosted tools and
specialized paths. Claude Code WebSearch and WebFetch use tool hooks.
Recommend protecting policy files from agent writes when used as controls.
For advanced session mappings or tool prices, explain the existing policy
schema and ask the operator to use its administrative configuration surface.
Do not silently hand-edit JSON to bypass these commands.

## Strict approval

Claude Code receives its native approval prompt. Codex currently cannot honor
an ask decision from a PreToolUse hook. AgentGuard holds that call and tells you
so. You cannot approve it: the approval token is never shown to you, and
running `approve`, `pending` or any policy-changing command from your shell is
stopped on every host. Tell the operator which call is waiting and stop there.
The operator lists held calls with `node runtime/policy-cli.cjs pending` in
their own terminal, approves one exact call, and asks you to retry it within
five minutes. The approval covers one matching session, tool, input hash and
policy; it cannot approve other arguments or a later policy version. Approval
does not bypass other guard rules or caps.

## Sync with Solo

Push is an explicit upload of allowed policy configuration only. Do not add
prompts, receipts, tool arguments, document text or credentials to policy.
The detached worker sends the Solo key in the Authorization header. The CLI
and hooks open no sockets. Other machines pull at session start and every
fifth heartbeat, about every 25 minutes. Failed Solo requests use local policy.
Free push prints the Solo upgrade message and makes no request. Team policies
remain owner-published in the dashboard. A blocked call is never permission
to push a weaker policy.

## Local STOP notifications

On macOS, an enforced STOP posts a local desktop notification with the rule ID and `resume with agentguard-burn resume`. Set `notifyOnStop: false` in the plugin policy to disable it; the default is `true`. Other platforms do not notify. Notifications use only local `osascript`, with no network requests, and cannot change the tool decision. Repeated delivery of the same signed decision does not notify again. Burn resume permits a Burn action; spend caps and other rules must be changed in the policy that stopped the call.
