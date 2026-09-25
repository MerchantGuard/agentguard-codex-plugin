## 0.3.11 - 2026-09-24

- The weekly line after a refused action on a free machine now says Free stays enforced there and points at Solo (the same policy on up to three machines, signed receipts export) instead of Team, and says how to dismiss it.

## 0.3.10 - 2026-09-24

- One yes, then it just happens: when the user asks for the full visual report, the score tool opens it in the default browser the moment the score is ready, through the platform opener with the report address as a single argument. Only on request, only on the consented origin, never on a failure; AGENTGUARD_NO_BROWSER=1 turns it off and a Linux session without a display never tries.
- The terminal keeps the summary; the browser carries the full report.

## 0.3.9 - 2026-09-24

- After an AgentGuard Score, the skill offers to open the full visual report in the browser (score ring, breakdown bars, every fix) at the agentguard.run report address, and opens nothing unless asked.
- The report question says what the link shows and where it is stored; the probe-mode note no longer points at a page that does not exist.

## 0.3.8 - 2026-09-24

- AgentGuard Score names its real destination. `agent_score_questions` returns `serviceOrigin`, the validated origin the answers would go to (https only, no credentials, path, query or fragment; https://agentguard.run unless `AGENTGUARD_SCORE_URL` is set), the consent wording in the skill names that origin, and an unusable `AGENTGUARD_SCORE_URL` makes `agent_score` refuse with `invalid_origin` instead of falling back.
- A hosted report link is a separate choice. `agent_score` takes `createShare` (default false), forwards it in the request, and returns `shareUrl` only when the user asked for a link and it is on the consented origin.
- The request refuses redirects, sends no credentials or referrer, reads at most 64 KB of response, and keeps one timeout across the request and the body read. A result is accepted only when it is complete and well formed (ok, an integer score from 0 to 100, a known tier, integer breakdown values, well-typed factors, parseable dates); anything else is `service_error` with no result to display. `assessmentType`, `questionnaireVersion` and `rubricVersion` pass through when present.
- Failure semantics: a network failure reports that no usable result was received and the service may have processed the request, and the tool never retries on its own. "Nothing was sent" is said only for refusals before any request (origin, consent, answers). Every refused or failed score call is returned as an MCP tool error with its structured reason, and a missing consent produces a score-specific message.
- Privacy wording: local policy enforcement and decision records stay on your machine; AgentGuard Score is the only MCP tool that makes a hosted request; paid licensing, seat renewal and optional policy sync are separate network features; score requests do not include your local policy, decision ledger or signing key.
- `get_status` reports `displayPreferences.quiet`, and the status skill never mentions the score when quiet is on or unknown. The free invitation is once per install and waits for a session start with nothing else to say. Version announcements are keyed by version.
- The questionnaire asks about four controls in plain words (an accountable human, where the money sits, limits the agent cannot change, a log the agent cannot edit), the wallet options cover custodial accounts, multi-sig, virtual cards and card-issuing APIs, bank accounts, personal wallets and none yet, and every question must be answered before anything is sent. The plugin collects no email address.
- The directory submission pack names the shipped version and all four skills.

## 0.3.7 - 2026-09-24

- Add AgentGuard Score to the plugin: a new `agentguard-score` skill and two MCP tools. `agent_score_questions` returns the five-question payment-readiness questionnaire offline; `agent_score` sends the answers, with the user's explicit consent, to the hosted AgentGuard Score service and returns the score, tier, category breakdown, factors with recommendations and a share link.
- `agent_score` is the only tool in the package that transmits anything off the machine. It refuses without `consent: true`, refuses answers outside the published questions and options before any request, reads no ledger, policy or key, writes nothing, and returns an error object rather than an estimated score when the service cannot be reached.
- Tool annotations mark `agent_score` open-world and non-idempotent; the other five tools keep their offline read-only annotations.

## 0.3.6 - 2026-09-23

- Add local policy presets, validated CLI customization, plain-language status and a once-only setup hint on both hosts.
- Add the optional inbox-reset-codes guard and strict approval for network-capable tools, with native Claude prompts and an operator-approved single call on Codex.
- Add Solo personal policy push and pull using the existing Team contract, hash, endpoint and refresh cadence. Sync state lives in one status file for the hook and the worker: a refused push touches nothing, a failed upload selects the local policy on both sides, and a pushed personal policy can only tighten Guard Pack rules.
- Add a weekly Free STOP invitation outside block reasons, one announcement per plugin version, and permanent quiet dismissal shared with the local Burn monthly summary.
- Held Codex calls are approved only from the operator's own terminal: a new policy-cli pending command lists them, the approval token is never shown to the model, and the show and explain helpers stay usable under strict only in their exact packaged form.
- A built-in STOP on every host covers tool calls that reach the plugin's own data directory, the Burn home or the hook IPC directory, and policy-cli commands that change policy or approvals.
- Command rules keep working when a command cannot be fully parsed: pattern rules run on the raw text, built-in matches use a conservative fallback, and the scan is recorded as scan_incomplete.
- Command patterns are validated as linear (no backreferences, nested quantifiers or quantified alternations) and the scanned text is capped, so a pattern can never take a hook past its budget.
- Built-in command matches cover more ordinary spellings: force-push flag clusters and the mirror flag, timeout, nohup, exec, time, xargs and eval prefixes, cd with a tilde or HOME, the env and sudo change-directory options, subshells, pushd, find with delete, unlink, rmdir, vercel with a path, vc, bunx vercel, firebase deploy, npm run deploy, bun publish and gh release create.
- Burn joins unsigned gateway decisions to their plugin mirror once and carries the monthly Team line on the summary so a JSON status prints what it consumed.
- Preserve failed-license fallbacks, paid receipt export and Team authority. Hooks and the policy CLI remain offline.
- Benchmark mode applies only with the operator's signed consent for the run (policy-cli benchmark on <run-id> writes one signed ledger row; the hook verifies it and falls through to normal enforcement otherwise). The environment switch alone never weakens Enforce.
- hookBudgetMs is validated at 250 ms or more and floored in the warm deadline, so a policy file cannot make every hook time out and fail open.
- A policy the worker cannot read keeps a definite built-in STOP as a stop; a block already decided survives a ledger append failure (the row is kept beside the ledger); MCP move, copy and rename tools count as writes for the plugin-state stop.
- Org policy refresh: a 204 after a ready snapshot withdraws to shadow with a reason instead of unbinding; an older version with a different hash and a published_at from the future are refused.
- The command-rule validator refuses a repeated group whose inner quantifier can consume its own separator (the (?:.*,)* family), and keeps ordinary idioms valid.
- Guard pack scanner: reserved words and wrapper commands on one line no longer hide the command; command substitutions and backticks stay inside their word and are scanned as nested commands, including inside double quotes and as arguments to a shell, eval or interpreter (the installer one-liner shape is GP001); here-strings feeding a shell are scanned; ANSI-C quoting is decoded; a carriage return stays in a word so CRLF heredocs close; nested shell bodies held in a literal variable resolve; long inputs are bounded and linear.
- GP002 resolves variable-built delete targets (HOME, PWD, pwd, mktemp, literals assigned earlier in the command); an unknown expansion is read both as a path component and as nothing, so a bare variable stops while a deep literal suffix is allowed; a wildcard confined to a generated build or cache directory, or over a generated-artifact extension, is cleanup.
- GP009 treats credentials.<code extension> as source and .env.example, .env.sample, .env.template and .env.dist as templates; every other env and credential file stays protected.
- GP010 requires a token boundary before a secret shape (sk- inside task-rest is an identifier) and ignores documented placeholders (EXAMPLE keys, runs of one character); realistic tokens anywhere still stop.
- GP014 treats a local path or an editable install as a local source; owner/repo shorthand is a GitHub source for the npm family only.
- Editor tools (str_replace_editor, str_replace_based_edit_tool and any tool named ...editor or ...edit_tool) are write tools; their view command is a read.
- Evals tooling (scripts/evals, never shipped in the package): the round-two harness, a release mapping in the replay, 236 red-team probes and a metamorphic suite as regression tests, and a freeze manifest at evals/manifest-round2.json.

## 0.3.5 - 2026-09-22

- Parse shell heredoc delimiters and bodies while scanning the surrounding commands, including nested shell calls.
- Retain local guard rule enforcement when incomplete parsing recovers a match. Clean command and patch data remain allowed.
- Add heredoc regression cases and measure decisions against pinned public Next.js eval transcripts.

## 0.3.4 - 2026-09-22

- On an enforced STOP on macOS, post a local notification with the rule ids and the resume command (policy flag notifyOnStop, default true; no-op elsewhere; never network). The notifier is detached so the hook never waits on it; AGENTGUARD_NOTIFY_SUPPRESS=1 silences it for tests and rehearsals.
- Team licenses carry the Stripe seat quantity: three or more seats, validated, cached and registered as paid seats.

## 0.3.2

## 0.3.3 - 2026-09-21

- Free Enforce follows the local policy on one machine with no account or key.
- Solo adds up to three machines, dashboard, receipts export and email support.
- Failed configured keys, seat denials and refresh failures retain shadow fallback and their reasons. Paid export and Team org policy gates remain.
- Update both hosts, status guidance and the Codex compatibility build for the new ladder.


- Add 14 built-in local guard rules across seven categories. Raw arguments stay in hook memory; signed records contain rule IDs and applied modes. Free/shadow warns, paid enforce stops, and only org/team policy can authorize downgrades.
- Measure hook overhead locally with scripts/measure-overhead.cjs; the result is written to docs/overhead.json for the site.

## 0.3.1

- Fetch the organization policy published in the dashboard through the detached worker and merge it as the root layer above team and local policy files; org enforce cannot be loosened locally.
- Report the loaded org policy hash in the seat heartbeat so admins can see which seats run the current policy. Heartbeats carry only license, machine, process and policy-hash identifiers.
- Revoked seats select shadow with seat_revoked at the next heartbeat; restoring a seat takes effect on a successful heartbeat.
- Team licenses cover ten seats.

## 0.3.0

- Add Claude Code packaging and host metadata to the shared runtime, signed decisions and status.
- Record failed Claude Code tools, preserve native permission prompts on allowed calls, and defer spawn accounting when a standalone Burn hook owns the call.
- Keep the Codex repository and package names, compatibility installation, license split and existing signed chains.

## 0.2.2

- Add directory review metadata, reproducible positive and negative cases, and public policy links. MCP status omits private worker fingerprints while preserving license and seat evidence.

- Count live seats across machines in the shared license KV store, with a fifteen minute active window and twenty four hour key expiry.
- Renew each live session every five minutes from the worker. Hook processes never send heartbeats, and heartbeat failures never change the current mode.
- Report seats used, the limit, storage and verification state through status and MCP. Memory fallback counts are marked unverified.
- Retain the startup seat limit check and a stable machine plus session process identity. Stop renewal on SessionEnd or host exit, with an activity lease when the host cannot be identified.

## 0.2.1

- Reply after signing and writing each plugin ledger row, then sync asynchronously and reconcile unconfirmed tails with signed integrity events on restart.
- Raise the warm response budget to 250 ms and accept `hookBudgetMs`, capped at 1900 ms below the host timeout; preserve the 1500 ms cold budget.
- Keep the Burn gateway inside that budget because its public API combines decisions, reservations and receipt writes.
- Report fail-open counts, rates and causes over the last hour and since worker start, with a warning above 5 percent.
- Reject every unexpected fail-open in normal hook tests and add isolated warm probes with delayed disk operations.

## 0.2.0

- Keep free sessions in signed shadow mode and license paid enforcement, team policies, and receipt export.
- Resolve licenses outside tool hooks with a two second deadline, cached offline grace, and existing seat metering.
- Report license tier, seats, expiry, effective mode, and shadow reasons in status tools.
- Replace local socket IPC with private files while retaining bounded fail-open hooks and signed recovery events.

## 0.1.1

- Adapt allowed hook responses to Codex 0.154 without changing signed decisions.
- Refresh the plugin version so existing installs can receive the compatibility fix.

## 0.1.0

- Preserve explicitly provisioned registry dependencies across Codex cache refreshes.

- Add public standalone distribution, portable packaging tests, and a reviewed sync workflow.
- Require the published Spend 0.20 series for actor attribution and per-agent cap selectors.

- Add local Codex and ChatGPT Work tool policy hooks, Burn delegation, signed content-free records, read-only MCP inspection, and operator skills.
