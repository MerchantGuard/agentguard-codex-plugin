# AgentGuard for Codex and ChatGPT Work

AgentGuard applies tool policies to **every local tool call that Codex or
ChatGPT Work sends through its hook path**, including plugin MCP tools. It
records signed decisions and outcomes locally without retaining tool input
contents or output text. Burn controls subagent spawning and sustained burn;
Spend controls the other calls using tool patterns, capability tiers, and
operator-configured unit costs. These unit costs use the Spend SDK pricing
path with a synthetic accounting unit; token counts in these decisions are
not observed model usage.

## Coverage and limits

The two `PreToolUse` hooks and the `PostToolUse` hook use matcher `.*`.
Supported paths include Bash, `apply_patch`/Edit/Write, MCP tools,
`update_plan`, and `spawn_agent`. Hosted tools such as WebSearch and web
ChatGPT are outside this hook path. `write_stdin` does not receive another
pre-tool decision for an already-approved shell session, and specialized tool
paths can opt out. The plugin therefore cannot provide universal interception.
See OpenAI's [tool coverage](https://learn.chatgpt.com/docs/hooks#tool-coverage).

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

For a law firm using Astra for Law in Codex or ChatGPT Work, the operator can
assign per-matter budgets, limit a document-review session to selected tools,
and deny tools across an ethical wall. The firm keeps the signed,
content-free record in its own environment. These controls describe tool
authorization and recorded activity; they make no claim about legal analysis
or model accuracy. Tool names and actor identifiers can still be sensitive
metadata, so the firm controls access to the policy, signing key, and records.

## Install

Use Node.js 22 and Codex CLI on macOS or Linux. The worker uses a private
POSIX Unix socket; Windows support is not implemented or verified.

Install from the [public repository](https://github.com/MerchantGuard/agentguard-codex-plugin):

```sh
codex plugin marketplace add MerchantGuard/agentguard-codex-plugin --ref main
codex plugin add agentguard@agentguard --json
```

The JSON result includes `installedPath`. Change into that directory and
install the locked registry dependencies:

```sh
npm ci
```

The plugin depends on published `@agentguard-run/spend ^0.20.0` and
`@agentguard-run/burn ^0.2.3`. It uses no sibling links. Codex's Git
marketplace installation does not install Node dependencies automatically.
Dependency setup may access npm; the hooks make no network requests.

### Trust the hooks

Start a new session, open **`/hooks`**, inspect both pre-tool gates and the
post-tool receipt command, and trust their definitions. Installing or
enabling the plugin does not perform this review. Trust is pinned to each
definition's current hash, so changed definitions require review again.
User hooks can take precedence over conflicting plugin decisions, and other
matching hooks run alongside these hooks.

See [hook review and trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

### Codex 0.154 compatibility

The canonical package follows the portable manifest documentation. Codex
CLI 0.154.0, however, skips hook sources for portable manifests in its
[released loader](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core-plugins/src/loader.rs#L954).
A portable installation can expose MCP tools while its hooks never run.

The public marketplace selects the generated installation at
`compat/codex-0.154/agentguard`. It contains `.codex-plugin/plugin.json` and
`.mcp.json`, with the same hook code, policy, skills, and assets. It omits
the portable root manifest because adding a legacy overlay alongside that
manifest would not change the loader's behavior.

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

### Private workspace marketplace

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

## Configure policy

The runtime reads `${PLUGIN_DATA}/policy.json`; the host supplies
`PLUGIN_DATA` to plugin hooks (the legacy MCP launcher derives the same path). An operator can instead launch Codex with
`AGENTGUARD_PLUGIN_POLICY` set to the policy file's absolute path. A missing policy
uses the packaged default: local decisions with no configured monetary charge
or cap. The offline hook never refreshes a Spend license over the network; an
existing license that requires an uncached refresh can cause a recorded
fail-open. Existing license/cache files remain under the user's configured
AgentGuard home. A corrupt policy causes a recorded fail-open, not a guessed policy.
Burn continues using its existing user policy and ledger under
`AGENTGUARD_HOME` or `~/.agentguard`; this plugin does not run Burn init or
enforce commands.

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
or credentials into them. Protect policy files from agent modification when
they serve as firm controls.

## Records and optional MCP server

The signed decision chain is stored at
`${PLUGIN_DATA}/ledger/decisions.ndjson`. Records include the tool name,
input SHA-256, encoded input/output byte counts, actor identifiers, decision,
and outcome. They never include `tool_input` or tool output text. Outcomes
link to the pre-tool decision ID. Duration uses host timing when supplied;
otherwise it is elapsed pre/post time and includes scheduling delay.
Explicit error flags and structured exit codes determine success or failure.
Codex 0.154's unified Bash hook sends only raw output, omitting its exit code;
those receipts record `status: "unknown"` and `success: null`. The plugin never
parses command output to guess success. See the
[released hook response implementation](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/context.rs#L404).

The optional local MCP server exposes only:

- `get_status`: summarize today's decisions, configured spend, blocks, and fail-open events.
- `list_decisions`: read a bounded page of signed entries.
- `verify_chain`: verify chain hashes and signatures.
- `export_receipts`: return a bounded JSON bundle for the caller to save.

The server does not change policies, write exports, or operate tools on your
behalf. To disable it while retaining the hooks, use the plugin-scoped setting
for the installed plugin (for this marketplace, `agentguard@agentguard`):

```toml
[plugins."agentguard@agentguard".mcp_servers.agentguard]
enabled = false
```

Status reports signed UTC-day fail-open events separately from pending audit
recovery. Pending counts cover all dates and can include duplicates from a
partly recovered batch; they are unsigned/unverified, not an additional
verified failure total.

Use `agentguard-status` for the UTC day summary and `agentguard-verify` for a
custodian export. Preserve the verification public key through a trusted
channel separate from the bundle. A self-contained key proves consistency
with that key, not who controlled it. Exporting the chain does not export the
signing private key.

## Managed installation and fail-closed firms

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

Managed delivery does **not** change these scripts' fail-open contract or
make the host fail closed on crashes or timeouts. Firms requiring fail-closed
access must enforce authorization at the document/MCP/payment service or
another control outside the agent hook, with their device administrator
managing delivery and availability. Copying this plugin into MDM alone is
insufficient. No managed configuration is installed by this package.

## Validate locally

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

## Publishing

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

## Packaging choices

The canonical `plugin.json` uses the portable Agent Plugins schema with OpenAI settings in
`extensions.com.openai`. `mcp.json` declares a local stdio transport. The
empty `.app.json` reserves the registered-app mapping without claiming a
registered external server. `Productivity` is the documented category used
for this governance workflow; the cited packaging page provides no dedicated
security category. Asset sizes are listed in [assets/README.md](assets/README.md).

The license terms are the same as the Spend package; see [LICENSE](LICENSE).
