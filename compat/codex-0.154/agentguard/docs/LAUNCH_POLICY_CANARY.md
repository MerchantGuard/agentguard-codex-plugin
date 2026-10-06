# Launch policy verification, October 5, 2026


Branch: `plugin/depth-and-model-oct5`, based on `origin/main` at `efa4bcf`. All runs used a scratch copy of the branch plugin and the unpublished branch Spend build. No production settings, publishing or deployment changed. Full signed chains, public verification keys and content-free historical attribution are in [the evidence file](launch-policy-canary.json). No signing private key is included.


Claude Code 2.1.289 ran in print mode on Haiku: three launch attempts, two started, one nested launch paused by the hook. The host recorded a permission denial because print mode could not show an interactive answer. The only model in the host usage result was `claude-haiku-4-5-20251001`, including the helper requested on sonnet. The coordinator was in the keep list. All eight ledger signatures and chain links verified. The existing standalone Burn hook was detected; count enforcement was deferred to it in these receipts. This run proves the new depth and model paths, not standalone count enforcement.


Claude helper rewrite, exact hook stdout:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "updatedInput": {
      "description": "Read fixture.txt file",
      "prompt": "Read the file fixture.txt",
      "subagent_type": "search",
      "model": "haiku",
      "run_in_background": false
    }
  }
}
```

Claude copy launching a copy, exact hook stdout:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "AgentGuard: Agent a2d779b389bdf6dae tried to launch at depth 2. Your depth limit is 1.\nAllow this one launch? If you say no, nothing starts.",
    "updatedInput": {
      "description": "Read fixture.txt",
      "prompt": "Read fixture.txt",
      "subagent_type": "search",
      "model": "haiku",
      "run_in_background": false
    }
  }
}
```

Claude signed model decision:

```json
{
  "sequence": 0,
  "decision": {
    "decisionId": "ada125df-428d-4567-8699-700257fedbaf",
    "timestamp": "2026-10-05T19:13:33.330Z",
    "action": "downgrade",
    "actor": {
      "tenantId": "local",
      "sessionId": "d5642286-db50-4124-9e71-9723d320646a",
      "agentId": "d5642286-db50-4124-9e71-9723d320646a"
    },
    "triggeredCap": null,
    "triggeredScopeKey": null,
    "projectedCents": 0,
    "windowSpendBefore": 0,
    "windowSpendAfter": 0,
    "provider": "claude-code",
    "modelRequested": "sonnet",
    "modelResolved": "haiku",
    "policyId": "agentguard-codex",
    "policyVersion": 1,
    "enforcementMode": "enforce",
    "reasons": [
      "burn_external_hook",
      "Helper token budget exceeded: 11024 tokens, budget 1; route search to haiku."
    ],
    "plugin": {
      "host": "claude-code",
      "schema": "agentguard.codex.v1",
      "requestId": "a6a21d65-79b2-42dc-87e5-bed44d1a8f00",
      "gate": "burn",
      "toolName": "Agent",
      "toolUseId": "toolu_01212fj3GPrhXhZJkFCpjZ7i",
      "sessionId": "d5642286-db50-4124-9e71-9723d320646a",
      "launch": {
        "depth": 1,
        "source": "claude_main",
        "callerId": "main",
        "parentAgentId": null,
        "callerType": null,
        "agentType": "search",
        "fromModel": "sonnet",
        "activeModel": null,
        "resumed": false,
        "modelRewriteSupported": true,
        "maxDepth": 1,
        "depthDecision": "within_limit",
        "modelDecision": "rewrite",
        "toModel": "haiku",
        "tokenBudget": 1,
        "sessionTokens": 11024,
        "reason": "helper_token_budget"
      },
      "inputSha256": "347369b2545095322ca15163a1445aefacec94fef8680d7e88571a42c741374f",
      "inputBytes": 144,
      "inputKeys": 5,
      "startedAt": "2026-10-05T19:13:33.312Z",
      "permissionMode": "default",
      "event": "decision",
      "reasonCode": "burn_external_hook",
      "license": {
        "paid": false,
        "tier": "free",
        "seatsUsed": null,
        "seatLimit": 1,
        "expiresAt": null,
        "mode": "enforce",
        "reason": null,
        "offlineGrace": false
      }
    }
  },
  "previousHash": "0000000000000000000000000000000000000000000000000000000000000000",
  "entryHash": "55234d3c30e88e736ec48f69824c798f5aac4f72c2587076f36bede7662a2570",
  "signature": "0f8b12dc0d80d69601e23a7c9cef5504d785350c3d0361c485b5d9afda99b80a5fad50facd2e63acb1fbe2fe4e5153d751cd713b0584152f2d93e8c7e44c1302",
  "signerFingerprint": "4ab9e85c2c108693",
  "publicKeyHex": "f0016e3e83c2966285dfc632a5021317b460d31b38b68daece0d8f2e0c881c88"
}
```

Claude signed depth decision:

```json
{
  "sequence": 5,
  "decision": {
    "decisionId": "63c0616d-4ec8-44ad-9a36-0d4411a159ea",
    "timestamp": "2026-10-05T19:13:43.333Z",
    "action": "block",
    "actor": {
      "tenantId": "local",
      "sessionId": "d5642286-db50-4124-9e71-9723d320646a",
      "agentId": "a2d779b389bdf6dae"
    },
    "triggeredCap": null,
    "triggeredScopeKey": null,
    "projectedCents": 0,
    "windowSpendBefore": 0,
    "windowSpendAfter": 0,
    "provider": "claude-code",
    "modelRequested": "sonnet",
    "modelResolved": "haiku",
    "policyId": "agentguard-codex",
    "policyVersion": 1,
    "enforcementMode": "enforce",
    "reasons": [
      "burn_external_hook",
      "launch_depth_limit",
      "Helper token budget exceeded: 31085 tokens, budget 1; route search to haiku."
    ],
    "plugin": {
      "host": "claude-code",
      "schema": "agentguard.codex.v1",
      "requestId": "5d9fc7b4-d35c-40d1-b695-f51063048f32",
      "gate": "burn",
      "toolName": "Agent",
      "toolUseId": "toolu_01XfRPkXyJW25dGuzx1NPXgR",
      "sessionId": "d5642286-db50-4124-9e71-9723d320646a",
      "agentId": "a2d779b389bdf6dae",
      "launch": {
        "depth": 2,
        "source": "claude_agent_sidecar",
        "callerId": "a2d779b389bdf6dae",
        "parentAgentId": null,
        "callerType": "coordinator",
        "agentType": "search",
        "fromModel": "sonnet",
        "activeModel": null,
        "resumed": false,
        "modelRewriteSupported": true,
        "maxDepth": 1,
        "depthDecision": "over_limit",
        "modelDecision": "rewrite",
        "toModel": "haiku",
        "tokenBudget": 1,
        "sessionTokens": 31085,
        "reason": "helper_token_budget"
      },
      "inputSha256": "f09e881e5bf77067720461a0dc4fb30baa6fbfdded6f322377308332c6685a35",
      "inputBytes": 130,
      "inputKeys": 5,
      "startedAt": "2026-10-05T19:13:43.320Z",
      "permissionMode": "default",
      "event": "decision",
      "reasonCode": "burn_external_hook",
      "license": {
        "paid": false,
        "tier": "free",
        "seatsUsed": null,
        "seatLimit": 1,
        "expiresAt": null,
        "mode": "enforce",
        "reason": null,
        "offlineGrace": false
      },
      "asked": true
    }
  },
  "previousHash": "2ac70be826ab907c1d60e8ccc708fd57f9bc9af10446db27266d7ee4d14a6f76",
  "entryHash": "6955186cc8928b7b7af948bb8335069a22ebed3a6ecd13b4144a4696d91324a2",
  "signature": "ae20cfb84d685457f46140477631f82c87e5a7147972aa1ad0cf90445e8d253bcc592ef9cbfdc423141102c24a6cd03a229dd8b1b43e024162081fc78e456c06",
  "signerFingerprint": "4ab9e85c2c108693",
  "publicKeyHex": "f0016e3e83c2966285dfc632a5021317b460d31b38b68daece0d8f2e0c881c88"
}
```

Codex CLI 0.160.0 ran successfully under Node 22.17.1 on gpt-6-luna. Its Node 25.8.2 wrapper failed with a missing darwin-x64 optional dependency. The successful probe made two launches. The first requested gpt-6-sol; the hook returned gpt-6-luna, and the child's next hook reported active model gpt-6-luna. The second inherited the already selected gpt-6-luna and stayed unchanged. All sixteen ledger signatures and chain links verified. The local canary plugin entry was removed afterward.


This CLI reports `collaborationspawn_agent`, with no helper type field. The canary opted into the explicit `default` type. Depth remained null; the count fallback was shown. The cumulative token event uses `event_msg.payload.info.total_token_usage`, which the pinned Burn parser did not recognize. The opt-in adapter passes that numeric total through Burn's replacement accounting, with estimated coverage.


Codex helper rewrite, exact hook stdout (the message is the host's opaque synthetic probe argument):

```json
{
  "systemMessage": "AgentGuard cannot verify launch depth here. The existing count limit still applies.",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": {
      "task_name": "search",
      "model": "gpt-6-luna",
      "fork_turns": "none",
      "message": "gAAAAABqw_WmQ9gSfJYRIvo12MLQ2cXLXBE2YCdB6Dj3j-mGBVYetU-Lr0TUR01at45K-JJndbdtzA4LsNlU-u_Bnwxk2N6LKkjRmGS0k9r81UToWWN-3G4x16AdfiDIc2NIKatfU8pjr-DTDA7vG65rit8o0aVZavVnFPuEhZV8sBfnseXJLaQzU7rjyNTlJEyXcgoEf_jU"
    }
  }
}
```

Codex observed child event, selected content-free fields:

```json
{
  "event": "PreToolUse",
  "tool": "Bash",
  "agentId": "01a10d77-9310-70b0-861a-fe6062aa6926",
  "model": "gpt-6-luna"
}
```

Codex signed model decision with missing-lineage fallback:

```json
{
  "sequence": 3,
  "decision": {
    "decisionId": "dd526d1f-66ac-493c-a678-326feb5ef02d",
    "timestamp": "2026-10-05T19:08:22.659Z",
    "action": "downgrade",
    "actor": {
      "tenantId": "local",
      "sessionId": "01a10d77-70c3-79e2-bcc0-afe3928aeba4",
      "agentId": "01a10d77-70c3-79e2-bcc0-afe3928aeba4"
    },
    "triggeredCap": null,
    "triggeredScopeKey": null,
    "projectedCents": 0,
    "windowSpendBefore": 0,
    "windowSpendAfter": 0,
    "provider": "codex",
    "modelRequested": "gpt-6-sol",
    "modelResolved": "gpt-6-luna",
    "policyId": "agentguard-codex",
    "policyVersion": 1,
    "enforcementMode": "enforce",
    "reasons": [
      "burn_ok",
      "Helper token budget exceeded: 14678 tokens, budget 1; route default to gpt-6-luna."
    ],
    "plugin": {
      "host": "codex",
      "schema": "agentguard.codex.v1",
      "requestId": "5190b0cf-5a13-4632-a2a3-ee3de276e0ec",
      "gate": "burn",
      "toolName": "collaborationspawn_agent",
      "toolUseId": "call_VwtPxI6RuPBickB3FjqQ6mIa",
      "sessionId": "01a10d77-70c3-79e2-bcc0-afe3928aeba4",
      "launch": {
        "depth": null,
        "source": "unavailable",
        "callerId": null,
        "parentAgentId": null,
        "callerType": null,
        "agentType": "default",
        "fromModel": "gpt-6-sol",
        "activeModel": "gpt-6-luna",
        "resumed": false,
        "modelRewriteSupported": true,
        "maxDepth": 1,
        "depthDecision": "lineage_unavailable",
        "modelDecision": "rewrite",
        "toModel": "gpt-6-luna",
        "tokenBudget": 1,
        "sessionTokens": 14678,
        "reason": "helper_token_budget"
      },
      "inputSha256": "3e1cdc3e203f6aa25f4a1260e252462f5e7aa2a6cdb2d30b1407d61e3edd0067",
      "inputBytes": 279,
      "inputKeys": 4,
      "startedAt": "2026-10-05T19:08:22.621Z",
      "permissionMode": "bypassPermissions",
      "event": "decision",
      "reasonCode": "burn_ok",
      "burnReceiptId": "muvmhkah-72ipoiz7",
      "license": {
        "paid": false,
        "tier": "free",
        "seatsUsed": null,
        "seatLimit": 1,
        "expiresAt": null,
        "mode": "enforce",
        "reason": null,
        "offlineGrace": false
      }
    }
  },
  "previousHash": "34935dc6030560a0170719b892305aedee000832d0e5c04b5146394b94fe3c98",
  "entryHash": "a6b5f307f820b51b190b68a9c792d884713a8ddde4638a3c929777421fa1144a",
  "signature": "cb7dfe8bd29d9bba3680bc15627bb24c5e9c9861d9ae9081571c91d136cd99d7332e24fdcbee5c317999d4a5842adef3c11281edc91b571119a9b4585343cb04",
  "signerFingerprint": "5d735a43cc041b5c",
  "publicKeyHex": "cd85f813b40bd57b8c7fdbf1a1b078c8305e3e0ec6a133a1e1299445956c3b94"
}
```

The earlier Codex probes exposed the tool alias and usage-shape gaps. One setup with user configuration ignored loaded no plugin hooks, and one probe refused to launch because its requested role parameter was unavailable. Neither was counted as successful verification. The runner now checks the hook effects before reporting success.


## Sep 23 lineage


Read-only sources were the film project at `~/Downloads/AGENTGUARD_FILM02_FANOUT_v2_2026-09-24/project`, the session `0b0c2202-d0be-4867-97a6-7e050a9b21e0` child transcripts and sidecars, and `~/.agentguard/decisions.ndjson`. The film builder identified nested launch attempts inside each caller's transcript. All five tool IDs join to enforced STOP records. Each caller has the same explicit agent ID in its transcript and filename, and each sidecar has `spawnDepth: 1`. The new gate reuses that caller ID and explicit sidecar depth, so their attempted children have depth 2. It does not parse a task description to infer depth.


```json
[
  {
    "callerId": "a134318a9c7788771",
    "spawnDepth": 1,
    "agentIdInTranscript": "a134318a9c7788771",
    "toolUseId": "toolu_016LfQV36scbbFpz9RZ7WXEc",
    "ledgerVerdict": "STOP",
    "enforced": true,
    "sessionId": "0b0c2202-d0be-4867-97a6-7e050a9b21e0"
  },
  {
    "callerId": "ac3d0ef80bb8e468e",
    "spawnDepth": 1,
    "agentIdInTranscript": "ac3d0ef80bb8e468e",
    "toolUseId": "toolu_018WTCMSkFqnutfd7EitV9if",
    "ledgerVerdict": "STOP",
    "enforced": true,
    "sessionId": "0b0c2202-d0be-4867-97a6-7e050a9b21e0"
  },
  {
    "callerId": "a3b8811a3c89b09c2",
    "spawnDepth": 1,
    "agentIdInTranscript": "a3b8811a3c89b09c2",
    "toolUseId": "toolu_011KcK2p1bimyMd6ipbiTLtm",
    "ledgerVerdict": "STOP",
    "enforced": true,
    "sessionId": "0b0c2202-d0be-4867-97a6-7e050a9b21e0"
  },
  {
    "callerId": "aa0731d5ce774ca2f",
    "spawnDepth": 1,
    "agentIdInTranscript": "aa0731d5ce774ca2f",
    "toolUseId": "toolu_019vVK43FxYRLbxECEpHU5wG",
    "ledgerVerdict": "STOP",
    "enforced": true,
    "sessionId": "0b0c2202-d0be-4867-97a6-7e050a9b21e0"
  },
  {
    "callerId": "aafba9a734258d4cd",
    "spawnDepth": 1,
    "agentIdInTranscript": "aafba9a734258d4cd",
    "toolUseId": "toolu_015L7eWqFMVp8fUczrvfx56x",
    "ledgerVerdict": "STOP",
    "enforced": true,
    "sessionId": "0b0c2202-d0be-4867-97a6-7e050a9b21e0"
  }
]
```

## Verification status and release prerequisites


Focused launch policy tests cover depths 1, 2 and 3, missing lineage and count fallback, token threshold crossing, signed rewrites, keep lists, unchanged defaults, host suggestions and operator approval, cumulative usage, shadow mode, policy self-override prevention and fail-open errors. The final plugin npm test run, explicitly pinned to Node 22.17.1, passed 559 of 563 tests with four optional analysis SDK tests skipped and zero failures. Spend npm test passed 336 of 338 tests with two optional mppx peer smoke tests skipped and zero failures. There are 23 new plugin tests and six new Spend tests. Compatibility output regenerated 88 files, and new files are listed in the public sync manifest.


An earlier repeat of the plugin suite had three cold-worker timeout failures. The final pinned run passed those tests without changing their assertions or timeout limits. The failed run did not record its Node version, so its cause is not attributed to a runtime version. Intermittent cold-worker startup timing remains a verification limitation.


UNVERIFIED: a person accepting or rejecting the interactive Claude prompt; a live Codex operator approval round trip for the unsupported-model suggestion; depth 3 in a real host; ChatGPT desktop local tasks; other host versions and custom role configurations. These have unit or documentation coverage where stated, not live claims. Unknown depth and usage remain explicit fallbacks.


Proposed release order: Spend 0.21.0, then plugin 0.4.0 with its Spend dependency and lock updated. The existing published dependency lacks the new routing export; branch tests used a maintainer staging script that stays in the source repository. No package was published and version metadata is unchanged.


Needed from the parallel Burn and counts-sync work: recognize the observed Codex collaboration alias, coordinate cumulative usage event ownership and migration so totals are counted once, and retain the explicit Claude caller ID and sidecar depth in any shared lineage interface. The new launch settings are local; site controls and the shared policy schema require a separate coordinated change before they can advertise synced configuration. No Burn, site, session-start tip or counts-sync source was edited.


Host contracts and configuration instructions: [launch policy documentation](LAUNCH_POLICY.md).
