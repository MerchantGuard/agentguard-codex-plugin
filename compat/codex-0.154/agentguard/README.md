# AgentGuard for Codex, ChatGPT Work and Claude Code

Codex and ChatGPT Work:

```sh
codex plugin marketplace add MerchantGuard/agentguard-codex-plugin
codex plugin add agentguard@agentguard
# In the installed plugin root reported by Codex:
npm ci
```

Claude Code:

```sh
claude plugin marketplace add MerchantGuard/agentguard-codex-plugin
claude plugin install agentguard@agentguard
# In the installed plugin root reported by Claude Code:
npm ci
```

AgentGuard records signed tool decisions in Codex, ChatGPT Work and Claude Code, with free shadow mode and licensed policy enforcement.

[Watch the Burn 0.2.5 usage clip](assets/burn-usage-preview.mp4).

## Details

AgentGuard applies tool policies to **every local tool call that Codex,
ChatGPT Work or Claude Code sends through its hook path**, including plugin MCP tools. It
records signed decisions and outcomes locally without retaining tool input
contents or output text. Burn controls subagent spawning and sustained burn;
Spend controls the other calls using tool patterns, capability tiers, and
operator-configured unit costs. These unit costs use the Spend SDK pricing
path with a synthetic accounting unit; token counts in these decisions are
not observed model usage.

### Coverage and limits

The two `PreToolUse` gates and receipt hooks use matcher `.*`.
In Codex, supported paths include Bash, `apply_patch`/Edit/Write, MCP tools,
`update_plan`, and `spawn_agent`. Hosted tools such as WebSearch and web
ChatGPT are outside this hook path. `write_stdin` does not receive another
pre-tool decision for an already-approved shell session, and specialized tool
paths can opt out. The plugin therefore cannot provide universal interception.
See OpenAI's [tool coverage](https://learn.chatgpt.com/docs/hooks#tool-coverage).

In Claude Code, coverage includes Bash, Read, Edit, Write, MCP tools, Agent
and the older Task spawn name. WebFetch and WebSearch pass through the Spend
gate at the read_only tier. Failed calls use PostToolUseFailure so their
outcomes are recorded too. Claude Code does not run PreToolUse for
EndConversation, and disabled hooks, work outside tool dispatch, and a host
crash remain outside the ledger. Built-in slash commands and model responses
are not tool calls. An allowed Claude gate returns no permission override,
so normal Claude Code permission checks still apply.
See [Claude Code hook events](https://code.claude.com/docs/en/hooks#pretooluse).

When a matching standalone Burn Claude hook is installed, the plugin defers
Burn accounting to that hook and records the deferral. It does not reserve
or charge the spawn twice. Separate installed hooks retain their own policy
and enforcement mode; the plugin does not disable them.


Hooks are **fail-open**. On an internal error, a gate allows the call, exits
successfully, emits a one-line warning, and records a fail-open event when
local storage is writable. A dead process, exhausted disk, inaccessible data
directory, or disabled/untrusted hook can prevent even that record. When the
signed writer is unavailable but local storage works, the client queues
content-free recovery metadata. Those pending records are unsigned and are
not part of the verified chain until the worker recovers them. An absent
receipt is not evidence that a tool was never used. The host can continue after
a hook failure or timeout. Do not use this plugin as the sole access control
for a client document system or payment service.

The warm worker deadline defaults to 250 ms. Set `hookBudgetMs` to a positive
integer in `policy.json` to change it; values above 1900 ms are capped to leave
100 ms before the host's two second hook timeout. Cold worker startup keeps
its 1500 ms deadline. These are response budgets, not wall time guarantees:
process startup, scheduling and a stalled operating system can add delay.

Burn's published gateway combines its decision, reservation, receipt and
ledger writes in one synchronous operation. That operation stays inside the
same response budget so reservation and receipt behavior stay intact. The
plugin does not defer or bypass Burn's own writes. Local probes exercise both
gates, including delayed Burn appends, without retrying failed-open calls.

For a law firm using Astra for Law in Codex or ChatGPT Work, the operator can
assign per-matter budgets, limit a document-review session to selected tools,
and deny tools across an ethical wall. The firm keeps the signed,
content-free record in its own environment. These controls describe tool
authorization and recorded activity; they make no claim about legal analysis
or model accuracy. Tool names and actor identifiers can still be sensitive
metadata, so the firm controls access to the policy, signing key, and records.

### Free and paid modes

Free mode signs and records every decision in shadow mode, blocks no tool
calls, and includes Burn why and pace. Any valid Solo, Startup or Growth
license, including Pro variants, enables enforce mode, team policy files,
receipts export and seat metering. These are the existing licenses; the
plugin has no separate plan. A paid policy can still choose shadow mode.

At session start, the detached worker resolves the license through
the Spend SDK. It makes one refresh attempt for that session, with a two
second deadline covering validation and seat registration. Hook processes
read only the local result and never open a socket. Without a usable cached
license, they remain in shadow until startup resolution finishes. A previously valid cached license is
retained offline for seven days after `expiresAt`; a server rejection does
not receive that grace. A failed license, seat or org refresh selects shadow
with a reason, even during grace. After grace the paid entitlement expires.
Unknown seat usage remains unknown during an outage.

The key comes from `AGENTGUARD_LICENSE_KEY`, otherwise the policy's
`licenseKey` field. Ask the `agentguard-policy` skill to
`activate license <KEY>` to save it in `policy.json` in the host plugin data directory and resolve
again. The activation helper receives the key on standard input, never in
command arguments or ledger entries. The environment variable takes
precedence over the saved key.

Without a usable license, each decision records `license_required` and the
engine forces shadow regardless of the requested mode. Seat registration
uses the existing license seat endpoint at session start. An exceeded startup
seat limit selects shadow with `seat_limit`. Licensing never denies a tool call.

The shared KV service counts a license's active heartbeats across machines
within a fifteen minute window. Its storage key has a twenty four hour
lifetime renewed by a heartbeat. The worker sends a bounded heartbeat every
five minutes for each live session, outside hook processes and without
waiting in the decision path. Heartbeat failures, later over-limit responses
and revocation select shadow with a reason. A revoked seat remains shadow
through failures until a successful heartbeat explicitly restores it. Heartbeats stop on `SessionEnd` or when
the identified host process exits. If the worker cannot identify a host
process, it uses a fifteen minute lease renewed by tool activity rather than
renewing an orphaned session indefinitely.

Use `agentguard-status` or the read-only MCP `get_status` tool to see the
recorded host, tier, `seatsUsed`, `seatLimit`, `seatStorage`, `seatsVerified`, expiry, effective
mode, and reason. `seatStorage` is `kv`, `memory`, or unknown. A verified count
comes from a valid shared KV response. Memory fallback is explicitly
unverified and does not establish cross-machine occupancy. After a failed
heartbeat, any retained count is an earlier observation, not a fresh verified
total; `seatsVerified` becomes false. `seatRefreshedAt` identifies the last
well-formed response, while `seatHeartbeatAt` and `seatHeartbeatError` describe
the latest heartbeat attempt. Signature verification stays free. Paid users
can ask `agentguard-verify` for an export, call `export_receipts`, or run
the host-specific local helper command in
[agentguard-verify](skills/agentguard-verify/SKILL.md) to write the signed bundle
locally. Set the destination to a path the operator authorized.

### Install

Use Node.js 22 with Codex CLI or Claude Code on macOS or Linux. Hooks communicate with the
worker through a private filesystem mailbox. Windows support is not verified.

Use the commands at the top to install from the
[public repository](https://github.com/MerchantGuard/agentguard-codex-plugin).
After adding the plugin, change into its installed root before running
`npm ci` to provision the locked registry dependencies.

The plugin depends on published `@agentguard-run/spend ^0.20.0` and
`@agentguard-run/burn ^0.2.3`. It uses no sibling links. Codex's Git
marketplace installation does not install Node dependencies automatically.
Claude Code installs locked npm dependencies for cached marketplace plugins
with lifecycle scripts disabled. The explicit `npm ci` step provisions this
package and its persistent dependency copy. Local-directory Claude
marketplaces do not automatically install those dependencies.
Dependency setup may access npm; the hooks make no network requests.

Keep npm lifecycle scripts enabled for this step. In a Codex cache installation,
the postinstall script also provisions the locked dependencies in the plugin's
persistent data directory. Codex 0.154 can replace its installation cache when
a session starts; the runtime uses this persistent copy if the cache no longer
contains dependencies. A changed lockfile requires running `npm ci` again.
Source checkouts keep their usual local dependencies. For a managed or custom
installation, set `PLUGIN_DATA` to the runtime's private data directory when
provisioning. No dependency downloads happen during a tool call.

#### Codex hook trust

Start a new session, open **`/hooks`**, inspect the session startup and end
commands, both pre-tool gates and the post-tool receipt command, and trust
their definitions. Installing or
enabling the plugin does not perform this review. Trust is pinned to each
definition's current hash, so changed definitions require review again.
User hooks can take precedence over conflicting plugin decisions, and other
matching hooks run alongside these hooks.

See [hook review and trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

#### Claude Code installation and trust

The Claude marketplace selects the repository root through
`.claude-plugin/marketplace.json`. It loads `.claude-plugin/plugin.json`,
the shared skills and runtime, native `hooks/hooks.json`, and `.mcp.json`.
The generated Codex hook configuration uses the same scripts and omits the
Claude-only failure event.

Review the marketplace and plugin source before installing. Accept the normal
workspace trust prompt only for a directory you trust. Claude Code's `/hooks`
menu is a read-only view of loaded hooks; it does not use Codex's per-hook
hash trust action. Restart the session or use `/reload-plugins` after changing
plugin definitions. Normal tool permission prompts remain in effect.
The shared skills include separate commands for each host. Claude substitutes
its exact path and session placeholders when loading a skill; Bash does not
inherit those plugin variables. Keep the skill's explicit environment
assignments when running activation or local verification helpers. Use the
read-only MCP tools when available.
See [Claude plugin installation](https://code.claude.com/docs/en/discover-plugins)
and [the hooks menu](https://code.claude.com/docs/en/hooks#the-hooks-menu).

Each host uses its own persistent data location. Set the documented plugin
data environment variable explicitly when provisioning a custom installation.
See the [Claude Code adapter and fixture notes](docs/CLAUDE_CODE.md) for field
mapping, coverage and the two-host test commands.

#### Codex 0.154 compatibility

The canonical package follows the portable manifest documentation. Codex
CLI 0.154.0, however, skips hook sources for portable manifests in its
[released loader](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core-plugins/src/loader.rs#L954).
A portable installation can expose MCP tools while its hooks never run.

The public marketplace selects the generated installation at
`compat/codex-0.154/agentguard`. It contains `.codex-plugin/plugin.json` and
`.mcp.json`, with the same hook code, policy, skills, and assets. It omits
the portable root manifest because adding a legacy overlay alongside that
manifest would not change the loader's behavior.

For unchanged inputs, Codex 0.154's
[hook response parser](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/hooks/src/engine/output_parser.rs#L441)
accepts an empty success object but rejects an explicit allow without rewritten
input. Generated compatibility hooks use that empty response for allowed calls.
Denials and signed ledger decisions retain their original values. The portable
hooks retain the documented explicit allow response.

The legacy MCP entry uses a relative working directory because the
[released parser](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/codex-mcp/src/plugin_config.rs)
does not expand plugin environment variables. Its read-only launcher derives
the hooks' data directory from the validated installation cache path using
the [released store layout](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core-plugins/src/store.rs#L131),
or accepts an explicit `PLUGIN_DATA`. It creates no directories.

`npm run build:compat` regenerates the compatibility installation after
canonical source changes. `npm run check:compat` and the tests reject stale
copies. Do not install the canonical portable directory directly into this
CLI release when you expect hooks to run. Future host versions and ChatGPT
Work require their own end-to-end validation.

#### Private workspace marketplace

A firm can use its own marketplace to distribute a reviewed copy internally.
Use `.agents/plugins/marketplace.json` with an `agentguard` entry pointing to
the compatibility installation, register the marketplace with Codex, then
install the plugin from that source. If its marketplace is also named
`agentguard`, the selector remains `agentguard@agentguard`; otherwise use the
firm's marketplace name.

In the desktop app, select that marketplace in the Plugins Directory and
install the plugin in a new chat. Scripts, dependencies, and Node must exist
wherever Work executes them. Surface availability varies; see
[marketplaces and packaging](https://developers.openai.com/plugins/build/plugins).

Making a repository public does not submit the plugin to the universal
directory. Workspace-wide publication through the administrative Plugins
interface is also a separate administrator action.

### Configure policy

The runtime reads `policy.json` in the host's plugin data directory. Codex
supplies `PLUGIN_DATA`; Claude Code supplies `CLAUDE_PLUGIN_DATA`. The legacy
Codex MCP launcher derives that same Codex path. When both are explicitly set,
`PLUGIN_DATA` keeps its existing precedence. Each host keeps its own data
unless the operator deliberately points them at a shared directory.
A paid operator can set `teamPolicyFile` in that file, or launch the host with
`AGENTGUARD_PLUGIN_POLICY`, to load a shared team policy. Relative team file
paths resolve from the host plugin data directory. The local license key remains local;
free sessions use the local policy without the shared rules. A missing policy
uses the packaged default: local decisions with no configured monetary charge
or cap. The license gate controls whether enforcement is available; hook
processes only read its local snapshot. Existing license/cache files remain
under the user's configured AgentGuard home. A corrupt policy causes a
recorded fail-open, not a guessed policy.
Burn continues using its existing user policy and ledger under
`AGENTGUARD_HOME` or `~/.agentguard`; this plugin does not run Burn init or
enforce commands.

### Published org policy

Team (ten seats) and 50-seat owners can publish a versioned policy in the
[dashboard](https://agentguard.run/dashboard/org-policy). Solo has no published
org policy. The detached worker fetches the root policy at session start,
alongside license refresh, and every fifth five-minute heartbeat. Hooks,
lifecycle helpers, activation helpers and status reads never open a socket.

The worker validates the shared field allowlist and SHA256 of recursively
key-sorted JSON, then atomically saves the last good envelope in
`${PLUGIN_DATA}/org-policy.json`, bound to the license fingerprint. Failed
fetches keep that copy, including through the existing seven-day grace,
and select shadow with a reason. No tool is denied because licensing or
org state is unavailable. A successful 204 means this license has no org
policy; any retained copy on disk is ignored.

- `allowedTools`: A tool must match an expression in every supplied list. An absent list adds no restriction; an empty list matches nothing.
- `deniedTools`, `ethicalWall`: Union of patterns, at root and within each session.
- `maxCapability`: Lowest ceiling across layers; session ceilings also apply.
- `caps`: Append all caps. Matching root and session caps apply together.
- `mode`: Org enforce, including its default, cannot be lowered locally. A lower layer may tighten org shadow to enforce. Licensing and failures still select shadow.
- `toolRules`: Local, then team, then org; matching org fields win.
- Identity and payment classification: Org values and its documented tenant/payment defaults are authoritative. Org default matter and explicit session mappings cannot be redirected locally.

For example, publish:

```json
{"version":1,"mode":"enforce","allowedTools":["^mcp__documents__.*$"],"deniedTools":["^mcp__documents__delete$"],"maxCapability":"data_write","caps":[{"window":"per_day","amountCents":500}]}
```

A local policy asking for shadow, `allowedTools: [".*"]`, no denies,
`maxCapability: "payment_execute"` and a larger cap does not loosen this
root. With healthy licensing, only matching document tools pass the
allowlists, delete remains denied, the ceiling remains data write, and both
caps apply. If a refresh fails, the same rules can record what they would
have blocked, but the call is allowed in shadow.

The published policy uses only the documented identifiers, expressions,
enums and numeric settings. `licenseKey` and `teamPolicyFile` remain local
and are rejected in published policies. Unknown fields at every level are
rejected. Identifier length is at most 128, expressions at most 512, and
lists or session maps at most 256 entries. See the
[wire contract](docs/ORG_FEATURES_CONTRACT.md).

AgentGuard's server is a control plane for policy, not data. It stores the policy your admin writes, which seats are licensed, and which policy version each seat last reported. It never receives a tool call, a prompt, a file, or a receipt.

Heartbeats contain exactly the license key, machine fingerprint, derived
process identifier and loaded org policy hash. An admin can label a machine
on the server, invite a teammate by license email, or revoke and restore a
seat. Labels are never sent to the machine. Revocation selects
`seat_revoked` shadow on the next heartbeat, never a denied call.
A matching hash does not attest enforcement. Pending invites cannot be
attributed to a person using a shared license key.

Use `agentguard-policy` to author policy examples. These are illustrative
configuration amounts, not measured charges:

```json
{
  "version": 1,
  "tenantId": "example-firm",
  "mode": "enforce",
  "maxCapability": "data_write",
  "defaultMatterId": "matter-example",
  "allowedTools": ["^mcp__imanage__(search_documents|read_document|save_document)$", "^update_plan$"],
  "deniedTools": ["^Bash$"],
  "ethicalWall": ["^mcp__restricted_matter__.*$"],
  "toolRules": [
    {"pattern": "^mcp__imanage__save_document$", "capability": "data_write", "unitCostCents": 2}
  ],
  "caps": [
    {"selector": {"taskId": "matter-example"}, "window": "per_day", "amountCents": 500, "action": "block"},
    {"selector": {"agentId": "reviewer-example"}, "window": "per_day", "amountCents": 100, "action": "block"}
  ],
  "sessions": {
    "session-example": {
      "matterId": "matter-example",
      "agentId": "reviewer-example",
      "ethicalWall": ["^mcp__other_matter__.*$"],
      "caps": [{"selector": {"sessionId": "session-example"}, "window": "per_day", "amountCents": 50, "action": "block"}]
    }
  }
}
```

Tool patterns are case-insensitive JavaScript regular expression strings; anchor names when
exact matching matters. `paymentPattern` is a configurable case-insensitive
expression matched against the MCP server/tool names or a local tool name.
Matching calls claim `payment_initiate`; Bash and file-changing tools claim
`data_write`. `toolRules[].capability` can raise a call's classification,
`requiredCapability` sets a required tier, and `maxCapability` limits the
session's permitted tier. Explicit denies, ethical-wall entries, and
allowlists are independent policy checks. The default monetary cost of an
unpriced tool is zero: a cap cannot constrain unknown third-party charges.

For `mcp__imanage__save_document`, the call's provider is `imanage` and model is
`save_document`. `actor.taskId` carries the matter identifier and
`actor.sessionId` carries the host session ID. Agent attribution uses a host
`agent_id` when present, then an operator session mapping, then the session
ID. A host that provides no subagent identity cannot produce independent
per-subagent accounting without an operator mapping. Policies contain
identifiers and patterns only; never paste documents, prompts, client names,
or provider credentials into them. The activation helper's `licenseKey` is
the sole credential exception and is never copied into the ledger. Protect policy files from agent modification when
they serve as firm controls.

### Records and optional MCP server

The signed decision chain is stored at
`${PLUGIN_DATA}/ledger/decisions.ndjson` in Codex and
`${CLAUDE_PLUGIN_DATA}/ledger/decisions.ndjson` in Claude Code. Records include the tool name,
input SHA-256, encoded input/output byte counts, actor identifiers, decision,
and outcome. They never include `tool_input` or tool output text. Outcomes
link to the pre-tool decision ID. Duration uses host timing when supplied;
otherwise it is elapsed pre/post time and includes scheduling delay.
Explicit error flags and structured exit codes determine success or failure.
Codex 0.154's unified Bash hook sends only raw output, omitting its exit code;
those receipts record `status: "unknown"` and `success: null`. The plugin never
parses command output to guess success. See the
[released hook response implementation](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/context.rs#L404).

Before replying, the worker signs and writes each complete plugin ledger row
to the operating system; a later asynchronous sync confirms a durable chain
head, so a crash or power loss can lose an unconfirmed tail. On restart it
verifies surviving rows against that head, discards only an incomplete final
row beyond it, and appends a signed integrity event when surviving evidence
shows an unconfirmed tail or sync failure; complete invalid rows are never
silently repaired.

An existing ledger without a durability checkpoint receives one conservative
integrity event on its first startup. Its original signed rows stay intact.
Integrity events appear separately from tool decisions in status reports.

The optional local MCP server exposes only:

- `get_status`: report license tier, seat count, limit, storage and verification status, expiry, effective mode and reason alongside today's decisions, configured spend, blocks, integrity events, and fail-open health.
- `list_decisions`: read a bounded page of signed entries.
- `verify_chain`: verify chain hashes and signatures on every tier.
- `export_receipts`: with a valid paid license, return a bounded JSON bundle for the caller to save.

The server does not change policies, write exports, or operate tools on your
behalf. In Codex, disable it while retaining the hooks through the plugin-scoped
setting for the installed plugin (for this marketplace, `agentguard@agentguard`):

```toml
[plugins."agentguard@agentguard".mcp_servers.agentguard]
enabled = false
```

Status reports signed UTC-day fail-open events separately from pending audit
recovery. Pending counts cover all dates and can include duplicates from a
partly recovered batch; they are unsigned/unverified, not an additional
verified failure total.

Status also reports fail-open count and rate over the last hour and since
the worker started. Each pre-tool gate invocation counts once, including
an allow when that gate does not govern the tool; post-tool calls are reported
separately. A client timeout and a late worker response share one request ID.
Either rate above 5 percent produces a one-line warning naming a known cause.
These operational counters are unsigned and may lag the signed ledger; status
labels an incomplete or truncated denominator instead of treating it as exact.

Use `agentguard-status` for the UTC day summary and `agentguard-verify` for a
custodian export. Preserve the verification public key through a trusted
channel separate from the bundle. A self-contained key proves consistency
with that key, not who controlled it. Exporting the chain does not export the
signing private key.

### Managed installation and fail-closed firms

See [Enterprise installation](docs/ENTERPRISE_INSTALL.md) for reviewed config
trust and managed hook delivery examples.

OpenAI supports administrator-managed hook configuration in
`requirements.toml`, with `features.hooks = true`,
`allow_managed_hooks_only = true`, and an absolute `hooks.managed_dir` (or
`windows_managed_dir` for a separately supported implementation). This
package currently uses the macOS/Linux path. MDM must distribute the reviewed scripts, Node, and
dependencies; Codex does not distribute them. Managed hooks are trusted by
policy and cannot be disabled through the user hook browser. Setting managed
hooks only excludes plugin hooks, so the administrator must install the
equivalent managed hook entries. See the
[managed hook configuration](https://learn.chatgpt.com/docs/hooks#managed-hooks-from-requirementstoml)
and [managed configuration documentation](https://developers.openai.com/codex/enterprise/managed-configuration).

The administrator installs the reviewed package and Node 22 through MDM,
then configures two `PreToolUse` commands and one `PostToolUse` command with
matcher `.*`. Use absolute script paths under the managed directory, and
set `PLUGIN_ROOT` plus a private per-user `PLUGIN_DATA` directory for each
command. Managed commands do not inherit plugin-specific paths simply
because they invoke these scripts. The reviewed commands are
`hooks/burn-gate.cjs`, `hooks/spend-gate.cjs`, and `hooks/receipt.cjs`.

License resolution also needs the reviewed session startup command. It
uses private file IPC to ask the detached worker for the bounded license refresh
outside the hook process. Include that startup entry when delivering managed
hooks; the tool gates only consume its saved result. Include the reviewed
`SessionEnd` command so a closing session removes its local heartbeat entry.
The worker maintains seat heartbeats outside those hook processes.

Managed delivery does **not** change these scripts' fail-open contract or
make the host fail closed on crashes or timeouts. Firms requiring fail-closed
access must enforce authorization at the document/MCP/payment service or
another control outside the agent hook, with their device administrator
managing delivery and availability. Copying this plugin into MDM alone is
insufficient. No managed configuration is installed by this package.

### Validate locally

From a source checkout:

```sh
npm ci
npm run build:compat
npm run check:compat
npm test
```

Tests use synthetic tool contents and isolated data directories. Warm gate
timing is measured against the already-running local worker; process startup,
the first dependency load, and disk failures are distinct from a warm
decision. No hook performs network requests. Read the measured test output
for the current machine rather than treating a timing target as a guarantee.

Run `node scripts/probe-hooks.cjs 12` from a source checkout for a fresh,
isolated warm probe of both gates. It prints wall timings, fail-open counts,
load averages and signed chain verification without retrying calls. The test
suite also runs 20 warm calls per gate while delaying disk operations by
40 ms; zero fail-opens is required. Synthetic policies and license snapshots
stay in scratch directories, and the probe makes no network requests.

### Publishing

The maintainer source checkout is the source of truth. Make changes there,
regenerate the compatibility installation, and run the tests before syncing.
Set `PUBLIC_CHECKOUT` to the local public checkout's root directory:

```sh
npm run build:compat
npm test
scripts/sync-public.sh "$PUBLIC_CHECKOUT"
```

Review the public checkout's diff and run its tests before committing. The
sync command prepares the public files; publication is the maintainer's
separate signed commit and push to
[MerchantGuard/agentguard-codex-plugin](https://github.com/MerchantGuard/agentguard-codex-plugin).
Do not edit generated compatibility copies directly. Repository distribution
does not run npm publish, deploy a service, or submit a directory listing.

### Packaging choices

The canonical `plugin.json` uses the portable Agent Plugins schema with OpenAI settings in
`extensions.com.openai`. `mcp.json` declares a local stdio transport. The
empty `.app.json` reserves the registered-app mapping without claiming a
registered external server. `Productivity` is the documented category used
for this governance workflow; the cited packaging page provides no dedicated
security category. Asset sizes are listed in [assets/README.md](assets/README.md).

The license terms are the same as the Spend package; see [LICENSE](LICENSE).
