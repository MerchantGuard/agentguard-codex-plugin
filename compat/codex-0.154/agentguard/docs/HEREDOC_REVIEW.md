# Independent Claude review

A fresh Claude Fable 5.1 session reviewed the scanner, Engine and regression tests. A second fresh session checked the remediation. Both reviews used supplied source text with tools disabled. Neither session executed a sample command or changed files. No Codex reviewer was used.

The review confirmed the requested delimiter forms, the twenty initial evasion cases, clean negative cases and the real Free enforcement test. Its findings led to these changes:

- Scan uncertainty no longer changes license or tool policy mode. Unknown branch context warns only for GP003 and GP004.
- Unquoted heredoc substitutions scan their executable spans. Arithmetic data is separated from nested command substitutions.
- Partial parsed commands and redirects survive an incomplete tail. Raw catalog matching remains a conservative fallback for command text.
- Heredoc input follows direct shells, nested shell scripts and cat or tee pipelines. Script stdin remains available to later commands.
- Quote removal, descriptor redirects, continued delimiter lines and subshell separators preserve command structure.
- The string that crosses the size budget still receives the secret-format check.

The review also identified existing limits involving generated shell text, additional wrapper programs, aliases and interpreter-specific syntax. These remain outside a bounded literal-command scanner. The fallback is intentionally conservative and uses the catalog patterns without truncating away potential matches. The public corpus comparison measures actual replay behavior, not complete shell coverage.

The compatibility runtime is generated from the canonical source and checked for equality before release. The local review responses are retained with the validation working files; no transcript content is included in the public eval reports.
