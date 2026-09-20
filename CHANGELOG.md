## 0.3.2

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
