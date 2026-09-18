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
