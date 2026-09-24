---
name: agentguard-score
description: Run the AgentGuard Score check for the user's agent. Ask the five questionnaire questions, ask separately whether the user wants the full visual report in the browser (a hosted report link), obtain explicit consent that names the service origin, send the answers through the agent_score tool, and report the score, tier, breakdown and recommendations. Local policy enforcement and decision records stay on the machine; this is the only MCP tool that makes a hosted request.
---

# AgentGuard Score

AgentGuard Score is a self-reported check of four controls around an agent
that moves money: an accountable human, where the funds sit, transaction limits
and an audit trail. It scores what the user reports and verifies nothing. Five
questions, about a minute, free. The AgentGuard Score service computes the
score; the plugin only presents the questions, validates the answers locally
and, with consent, sends them.

Say this before anything else: local policy enforcement and decision records
stay on your machine. AgentGuard Score is the only MCP tool that makes a hosted
request. Paid licensing, seat renewal and optional policy sync are separate
network features. Score requests do not include your local policy, decision
ledger or signing key. No email address is collected.

## Steps

1. Call the AgentGuard MCP server's `agent_score_questions` tool with `{}`.
   It returns `intro`, `questions` (each with `id`, `question`, `type`,
   `options` for select questions and `category`) and `serviceOrigin`, the
   validated address of the service the answers would go to. Show the intro.
   If `serviceOrigin` is null, `AGENTGUARD_SCORE_URL` is not a usable https
   origin; say so, say that nothing was sent, and stop. Never substitute a
   placeholder or another address.

2. Ask the user each question in the returned order, one at a time. For a
   `select` question offer the published options exactly as written and record
   the chosen option string. For a `boolean` question record `true` or `false`.
   Every question must be answered; a partial set is refused. Do not invent
   options, do not guess an answer the user did not give, and do not answer on
   the user's behalf from anything you observed in the session.

3. Ask about the visual report as a separate choice, in these words: "Do you
   want the full visual report in your browser? It creates a report link with
   the score ring, the breakdown bars and every fix. The report is stored on
   the service and visible to anyone who has the link." Record yes or no. The
   default is no.

4. Show the five answers back, then ask for consent in these words, filling in
   the real `serviceOrigin` and the clause that matches the sharing choice:
   "Send the five answers shown above to the AgentGuard Score service at
   {serviceOrigin}? This request does not include your files, local policy,
   decision ledger or signing key. {It will also create a hosted report link
   that shows your answers and score to anyone who has it. | It will not
   create a report link.} Proceed?" Only a clear yes counts. If the answers or
   the origin change afterwards, ask again.

5. Call `agent_score` with `{"answers": {...}, "consent": true, "createShare":
   true|false}` matching the sharing choice. Without `consent: true` the tool
   refuses and sends nothing. Answers outside the published questions or
   options, or a missing answer, are refused before any request is made.

6. Report the result. Give the `score` out of 100 and the `tier`. Show each
   category in `breakdown`. List every factor with `impact: "negative"`
   together with its `recommendation`; those are the things to fix. Mention the
   positive factors briefly. Show `shareUrl` only when the user asked for a
   report link; if they asked and it is null, say the service did not return a
   usable link. When there is a `shareUrl`, present it as the full visual
   report and offer to open it: "Full visual report: {shareUrl}. Want me to
   open it in your browser?" If the user says yes, run the platform's opener
   with that exact address and nothing else: `open {shareUrl}` on macOS,
   `xdg-open {shareUrl}` on Linux, `start "" {shareUrl}` on Windows. Never
   open a browser without being asked, and never open any other address.
   Note `validUntil` if the user asks how long the score stands.
   Say that the result came from `serviceOrigin`. A one-line summary the user
   can paste into a README or a pull request is useful: the score, the tier,
   the valid-until date and, when requested, the link.

A refused or failed call arrives as a tool error that still carries a
structured result. Say what happened from its `reason`:

- `invalid_origin`, `consent_required` and `invalid_answers` are refused before
  any request; nothing was sent. `invalid_answers` lists the problems.
- `network` means no usable result was received and the service may have
  processed the request. Do not retry on your own and do not invent a result;
  tell the user and let them decide whether to try again.
- `service_error` means the service answered but returned an unusable result,
  an error status or an oversized response. No result is available to display.

Never fabricate a score, a tier or a link.

Probe mode, where the service sends test requests to a live agent webhook, is
not available from the plugin yet.

The score is a self-reported check of four controls. A payment network or
marketplace may still decline the agent. Do not present the score as more than
that.
