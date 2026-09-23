# Heredoc validation for 0.3.5

The regression suite covers quoted, unquoted and tab-stripped delimiters, multiple queued bodies, nested shell calls, patch data, incomplete input and 20 independently written evasion cases. Additional cases cover descriptor prefixes, continued delimiter lines and preservation of already parsed matches. No sample command is executed.

The test suite contains 366 tests per host. The existing benign corpus remains at 356 commands with zero matches.

The public corpus comparison uses the real scanner and Engine, the default Free enforce policy and explicit nonshared branch context. Local state is isolated and notifications are suppressed. The data source is [Vercel next-evals-oss](https://github.com/vercel/next-evals-oss/tree/bb7c02e847ac5beec71614cc8bb0c2a635db7ab2), licensed under [MIT](https://github.com/vercel/next-evals-oss/blob/bb7c02e847ac5beec71614cc8bb0c2a635db7ab2/LICENSE), Copyright (c) 2025 Vercel. Downloads use curl and are verified against Git blob hashes.

Across 131 result sets, 1,683 runs have result records and 123 lack published raw transcripts. The 1,560 available transcripts contain 25,638 tool actions, including 20,932 commands and edits. Incomplete scans fall from 38 to 1. Stops on passing runs fall from 2 to 1. Total stops fall from 10 to 6 after distinguishing interpreters that execute stdin from programs that read it as data. Warnings remain at 124. These are replay decisions, not claims about live host coverage or all shell syntax.

The requested Sep 22 Opus and Sol pair reproduces the baseline of 757 commands and edits, zero stops and 7 incomplete scans. The fixed scanner has zero stops and zero incomplete scans on that pair. Four read actions are also evaluated by the Engine, giving 761 total tool actions.

The remaining passing-run stop entry is agent-036-after-response with GP009. Full content-free per-set counts appear in [heredoc-public-evals.json](heredoc-public-evals.json).

Delimiter continuation handling follows the [GNU Bash redirection reference](https://www.gnu.org/s/bash/manual/html_node/Redirections.html).
