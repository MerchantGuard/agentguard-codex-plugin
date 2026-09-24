---
name: agentguard-score
description: Run the AgentGuard Score check for the user's agent. Ask the five questionnaire questions, obtain explicit consent, send the answers to the hosted AgentGuard Score service through the agent_score tool, and report the score, tier, breakdown, recommendations and share link. This is the only AgentGuard feature that transmits anything off the machine.
---

# AgentGuard Score

AgentGuard Score tells a builder whether their agent is ready to move money:
whether it has a verified human sponsor, how its wallet is set up, and whether
transaction limits and an audit trail exist. It takes five questions and about
a minute. The result is a score out of 100, the specific things to fix, and a
shareable report the builder can show a payment provider or a marketplace. It
is free. The hosted AgentGuard Score service computes the score; the plugin
only presents the questions, validates the answers locally and, with consent,
sends them.

Say this before anything else: every other AgentGuard tool works offline and
nothing leaves the machine. This check is the exception. The questionnaire
answers, and an email address if the user chooses to give one, are sent to the
hosted AgentGuard Score service. Enforcement, the ledger, the policy and the
signing key are not involved and are not sent.

## Steps

1. Call the AgentGuard MCP server's `agent_score_questions` tool with `{}`.
   It returns `intro` and `questions`, each with `id`, `question`, `type`,
   `options` for select questions and `category`. Show the intro.

2. Ask the user each question in the returned order, one at a time. For a
   `select` question offer the published options exactly as written and record
   the chosen option string. For a `boolean` question record `true` or `false`.
   Do not invent options, do not guess an answer the user did not give, and do
   not answer on the user's behalf from anything you observed in the session.

3. Ask whether the user wants a share link tied to an email address. The email
   is optional. If they decline, do not send one.

4. Ask for consent in plain words: "These five answers (and your email, if you
   gave one) will be sent to the hosted AgentGuard Score service to compute the
   score. Nothing else leaves this machine. Proceed?" Only a clear yes counts.

5. Call `agent_score` with `{"answers": {...}, "consent": true}` and `"email"`
   only if one was given. Without `consent: true` the tool refuses and sends
   nothing. Answers outside the published questions or options are refused
   before any request is made.

6. Report the result. Give the `score` out of 100 and the `tier`. Show the
   `breakdown` for risk, compliance, infrastructure and history. List every
   factor with `impact: "negative"` together with its `recommendation`; those
   are the things to fix. Mention the positive factors briefly. Give the
   `shareUrl` when present, and note `validUntil` if the user asks how long the
   score stands.

If the result has `ok: false`, say what happened from its `reason`:
`consent_required` means step 4 was skipped; `invalid_answers` lists the
problems and nothing was sent; `network` or `service_error` means the service
could not produce a score and there is no partial or estimated score to give.
Never fabricate a score.

Probe mode, where the hosted service sends test requests to a live agent
webhook, is not available from the plugin yet. Point the user to the hosted
AgentGuard Score page if they want that.

The score is a self-reported readiness check. A payment network or marketplace
may still decline the agent. Do not present the score as more than that.
