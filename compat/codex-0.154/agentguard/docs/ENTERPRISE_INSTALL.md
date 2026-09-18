# Enterprise installation for Codex 0.154

This guide targets the OpenAI source tag `rust-v0.154.0`. IT first reviews a
specific AgentGuard release, installs its Codex 0.154 compatibility bundle,
and provisions its registry dependencies with `npm ci`. The four bundled
hooks are the two tool gates, the outcome recorder, and SessionStart license
resolution. MCP and skills continue to come from the firm's private
marketplace.

Codex admits an enabled hook only when its trust status is Trusted or Managed,
unless the operator explicitly bypasses trust. Managed hooks are enabled by
policy and ignore individual user disable state. These are host trust rules;
they do not change AgentGuard's license or failure behavior.
[Admission and trust rules, discovery.rs lines 710 to 825](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/hooks/src/engine/discovery.rs#L710).

## Path A: distribute reviewed trust through config

1. Install and provision the reviewed plugin on an IT test machine. Open
   `/hooks`, inspect each definition, and trust the reviewed hooks.
2. From the reviewed package, print the matching config fragment. Replace
   `INSTALLED_PLUGIN_ROOT` with the root returned by the plugin installation.

   ```sh
   node scripts/print-trust-state.cjs INSTALLED_PLUGIN_ROOT agentguard@agentguard > reviewed-hooks.toml
   ```

   For a private marketplace named `firm`, pass `agentguard@firm` as the last
   argument. The marketplace is part of the key. The installed directory is
   not part of the hash, because Codex hashes the command before substituting
   its plugin environment variables.
   [Plugin key source, declarations.rs line 35](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/hooks/src/declarations.rs#L35),
   [key format, lib.rs line 113](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/hooks/src/lib.rs#L113),
   [normalization before expansion, discovery.rs lines 557 to 572](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/hooks/src/engine/discovery.rs#L557).
3. Review the printed `[hooks.state."..."]` tables and deliver them in the
   managed config. On macOS, base64 encode that TOML and supply the resulting
   string as `config_toml_base64` in managed preferences for `com.openai.codex`.
   The script only prints TOML. It does not modify trust, install a plugin,
   change a policy or contact a service.
   [Managed preference keys, macos.rs lines 20 to 22](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/config/src/loader/macos.rs#L20).

The script targets AgentGuard's command hooks and refuses other handler types.
It reproduces Codex's normalized identity and SHA-256 hash. The
identity contains the event, effective matcher, and one normalized handler.
Defaults such as timeout and async are included. Keys inside its JSON
representation are sorted recursively before hashing. Codex's own trust
button writes the same `trusted_hash` values into `hooks.state` with a config
batch update.
[Identity, discovery.rs lines 766 to 791](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/hooks/src/engine/discovery.rs#L766),
[hashing, fingerprint.rs lines 50 to 81](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/config/src/fingerprint.rs#L50),
[TUI config update, hooks_rpc.rs lines 57 to 89](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/tui/src/hooks_rpc.rs#L57).

### What a changed hash detects

Changing the normalized command, matcher, timeout or other hashed definition
changes its hash. An existing trust entry then becomes Modified, and the hook
needs review before it runs. A new key has no trust entry and becomes
Untrusted. Equivalent formatting and explicitly written defaults need not
change the hash.
[Trust comparison, discovery.rs lines 794 to 825](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/hooks/src/engine/discovery.rs#L794).

The hash does not include the bytes of a referenced script or its imported
modules. Editing only those files does not trigger Modified. IT must preserve
its reviewed release and file integrity independently. This is evidence of a
changed hook definition, not a signature over the executable bundle.
[The complete hashed identity, discovery.rs lines 766 to 791](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/hooks/src/engine/discovery.rs#L766).

## Path B: managed hooks through macOS MDM

Use this path when the firm controls which hook definitions run. Put the
reviewed, provisioned compatibility bundle at `/Library/AgentGuard/plugin`
and a reviewed Node.js 22 executable at `/Library/AgentGuard/node/bin/node`.
Keep the complete bundle: the three tool scripts and SessionStart script
import files from `runtime`, and the runtime needs its policy defaults,
manifest, lockfile and dependencies. IT owns the executable files; each user
owns their separate data directory.

The example assumes the private marketplace is named `firm`. Its plugin data
is `${CODEX_HOME:-$HOME/.codex}/plugins/data/agentguard-firm`, matching the
plugin's legacy MCP data selection. Keep that marketplace name and data path
consistent so hooks, skills and MCP see the same policy and signed ledger.

Save this as `requirements.toml`:

```toml
allow_managed_hooks_only = true

[hooks]
managed_dir = "/Library/AgentGuard/plugin/hooks"

[[hooks.PreToolUse]]
matcher = ".*"

[[hooks.PreToolUse.hooks]]
type = "command"
command = 'env PLUGIN_ROOT="/Library/AgentGuard/plugin" PLUGIN_DATA="${CODEX_HOME:-$HOME/.codex}/plugins/data/agentguard-firm" /Library/AgentGuard/node/bin/node /Library/AgentGuard/plugin/hooks/burn-gate.cjs'
timeout = 2

[[hooks.PreToolUse.hooks]]
type = "command"
command = 'env PLUGIN_ROOT="/Library/AgentGuard/plugin" PLUGIN_DATA="${CODEX_HOME:-$HOME/.codex}/plugins/data/agentguard-firm" /Library/AgentGuard/node/bin/node /Library/AgentGuard/plugin/hooks/spend-gate.cjs'
timeout = 2

[[hooks.PostToolUse]]
matcher = ".*"

[[hooks.PostToolUse.hooks]]
type = "command"
command = 'env PLUGIN_ROOT="/Library/AgentGuard/plugin" PLUGIN_DATA="${CODEX_HOME:-$HOME/.codex}/plugins/data/agentguard-firm" /Library/AgentGuard/node/bin/node /Library/AgentGuard/plugin/hooks/receipt.cjs'
timeout = 2

[[hooks.SessionStart]]

[[hooks.SessionStart.hooks]]
type = "command"
command = 'env PLUGIN_ROOT="/Library/AgentGuard/plugin" PLUGIN_DATA="${CODEX_HOME:-$HOME/.codex}/plugins/data/agentguard-firm" /Library/AgentGuard/node/bin/node /Library/AgentGuard/plugin/hooks/session-start.cjs'
timeout = 2
```

The TOML table is `[hooks]`. `managed_hooks` is its internal Rust field after
requirements are resolved. `managed_dir` identifies the managed hook source;
it does not supply the plugin's environment variables. This is why every
command sets `PLUGIN_ROOT` and `PLUGIN_DATA`. Windows has a separate
`windows_managed_dir` field; the macOS commands above are not Windows commands.
[Requirements schema, config_requirements.rs lines 995 to 1012](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/config/src/config_requirements.rs#L995),
[internal field conversion, config_requirements.rs line 1960](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/config/src/config_requirements.rs#L1960),
[managed source and empty environment, discovery.rs lines 217 to 239](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/hooks/src/engine/discovery.rs#L217),
[platform directories, hook_config.rs lines 242 to 282](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/config/src/hook_config.rs#L242).

`allow_managed_hooks_only = true` excludes user, project, session and bundled
plugin hook sources. The requirements hooks above take their place. Keep the
plugin's MCP server and skills installed from the private marketplace.
[Source filtering, discovery.rs lines 84 to 113](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/hooks/src/engine/discovery.rs#L84).

Package the requirements as a managed preference value:

```sh
python3 - <<'PY'
import base64
import pathlib
import plistlib
encoded = base64.b64encode(pathlib.Path("requirements.toml").read_bytes()).decode("ascii")
settings = {"requirements_toml_base64": encoded}
pathlib.Path("com.openai.codex.plist").write_bytes(plistlib.dumps(settings))
PY
```

Deliver those settings through your MDM's managed preferences payload for
application identifier `com.openai.codex`. The generated plist contains the
application settings, not a complete enrollment profile. For Path A, use the
same packaging with `reviewed-hooks.toml` and the key `config_toml_base64`.
Codex reads those preference values, decodes their base64 text and parses the
TOML.
[Preference lookup and parsing, macos.rs lines 123 to 181](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/config/src/loader/macos.rs#L123).

## Verification and limits

The script was compared against an actual Codex 0.154.0 install in an isolated
home. Each of the four hooks was reviewed and trusted through normal `/hooks`.
The four keys and hashes written by Codex matched the script output exactly.
The comparison diff was empty. No trust bypass was used. Tests also cover
normalization, changed definitions, private marketplace keys and the fact that
script contents are outside this hash.

MDM enrollment, managed preference delivery and the managed hook path above
have not been executed on a managed device. Windows execution has not been
verified. Treat the example as a source-checked configuration to review and
exercise in the firm's staging environment.

MDM delivery does not turn fail-open hooks into fail-closed authorization.
AgentGuard still allows a tool call on an internal hook error or timeout.
Free licenses and unavailable entitlement checks still select shadow mode
according to the documented cache and grace rules. A firm that needs
fail-closed authorization must enforce it at its tool or service boundary.
