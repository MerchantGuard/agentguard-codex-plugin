# Public Next.js eval replay

Data source: [Vercel next-evals-oss](https://github.com/vercel/next-evals-oss), MIT, Copyright (c) 2025 Vercel. The scorer pins a source commit, checks the license and verifies downloaded artifacts against Git blob hashes. Transcripts are never executed. Downloads use curl.

Install the plugin dependencies with npm ci. Install the isolated analysis dependencies with npm run setup:public-evals. This pins Burn 0.3.5 without changing the production Engine dependency set.

Run scripts/score-public-evals.cjs with Node and one or more result-set paths. Each path can be results/model/timestamp, model/timestamp, or a GitHub tree URL. The output option chooses the report directory; cache chooses a separate raw-data cache; revision selects an immutable source commit. The all-current option adds every published timestamp for the model families whose pinned metadata names Claude Code or Codex. Both base and docs variants are included. Explicit paths can add other harnesses, including Grok's OpenCode results.

The CLI options are shown here as executable syntax:

```sh
npm ci --ignore-scripts
npm run setup:public-evals
node scripts/score-public-evals.cjs \
  --output /private/tmp/public-eval-reports \
  claude-opus-5.5-high/2026-09-22T20-34-17.138Z \
  gpt-6-sol-high/2026-09-22T19-54-01.135Z
node scripts/score-public-evals.cjs --all-current --output /private/tmp/public-eval-reports
```

Each observed tool call is scanned by the real guard pack and passed to its owning Engine gate: Spend for ordinary tools and Burn for spawns. The Engine reads the shipped default policy and real Free license state in enforce mode. State is isolated per scorer invocation, run identities are separate, branch context is explicitly nonshared, and notifications and telemetry are suppressed. No receipt or live child lifecycle is invented. This measures admission decisions for observed calls, not a simulation of the whole host lifecycle.

Claude assistant tool-use blocks are deduplicated by call ID. Codex command starts and completed file changes are counted once; web searches, task lists and collaboration calls are included too. Search completion events supply the query or URL when the start is a placeholder. File-change events expose paths without patch bodies. OpenCode inputs are adapted to plugin tool names. Missing transcripts, malformed rows, unknown formats and unsupported event types remain visible in the counts. A passing run is determined only by result.json status. Every stop on a passing run is listed as a false positive by eval name and rule ID.

Burn 0.3.5 reads Claude usage and runs its replay API for spawns and replay share. Its insights parser and pricing function also read available Codex usage with model identity from result.json. Explicit Vercel spellings claude-opus-5.5 and claude-fable-5.1 map to the same model IDs in Burn's table. Other missing prices stay unpriced; the known priced subset is shown separately. Cache-write lifetimes can produce a cost range. These are API list-price equivalents for available parent transcripts, not billing totals or estimates of missing child transcripts.

[Codex exec usage](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts) aggregates a whole turn. If that sum exceeds a model context-price threshold, it does not prove that any individual request crossed the threshold. The scorer uses Burn's pricing function with the base and long-context SDK rates to report a range, and counts these uncertain turns. Model identity from result.json is the requested evaluation model when the native transcript omits a provider-returned model ID.

OpenCode step-finish records provide numeric usage. The adapter deduplicates step IDs and includes separately recorded reasoning in output tokens, following [OpenCode's usage accounting](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts). These counts use Burn's pricing function too. The host's reported cost field is not used as a list price. Grok 4.7 has no entry in the pinned price table and remains unpriced.

Model spelling references: [Vercel Opus 5.5](https://vercel.com/ai-gateway/models/claude-opus-5.5), [Vercel Fable 5.1](https://vercel.com/ai-gateway/models/claude-fable-5.1). Prices and calculations come from the pinned Burn package.

Each model receives JSON and Markdown reports, with per-result-set counts in JSON. The report directory contains counts, eval names, rule IDs and provenance. Commands, prompts, patches, file contents and tool outputs stay out of reports. Keep the separate raw cache private when sharing reports.
