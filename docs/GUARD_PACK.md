# Built-in guard pack

Every installation includes these deterministic rules. The hook inspects tool
arguments in memory, emits matching rule IDs into local worker IPC, and discards
the arguments. Neither the scanner nor the hook opens a socket or calls a model.
The existing metadata hashes and byte counts remain content-free.

Effective shadow mode produces WARN with the rule ID. Enforce mode on every
tier, including Free without a key, produces STOP by default. An incomplete
scan retains recovered rule matches and records its scan reason. Unknown
branch context warns for GP003 and GP004 without demoting other rules or
tool policy. Policy, license and worker failures retain their existing shadow
or fail-open behavior when local storage is writable.
An off rule produces no warning. Existing tool policy and Burn checks still
apply independently.

| ID | Category | Matching operation | Human reason |
| --- | --- | --- | --- |
| GP001 | Remote shell | curl/wget piped to sh/bash/zsh/python/python3 | A downloaded response is being executed by a shell or Python. |
| GP002 | Recursive deletion | Recursive rm/Remove-Item on root, home, current/parent directory or a shallow wildcard | Recursive deletion targets a root, home, current directory or shallow wildcard. |
| GP003 | Git history | Force or force-with-lease push to main/master | A force push targets the shared main or master branch. |
| GP004 | Git history | Hard reset on main/master or unknown branch | A hard reset targets a shared branch or a branch whose state is unknown. |
| GP005 | Git history | git clean with f, d and x, excluding dry runs | Git clean would remove untracked directories and ignored files. |
| GP006 | Infrastructure | terraform apply/destroy with auto-approve enabled | Terraform would apply infrastructure changes without interactive approval. |
| GP007 | Infrastructure | kubectl delete namespace/ns, excluding dry runs | Kubernetes would delete a namespace. |
| GP008 | Infrastructure | aws/gcloud delete, terminate or disable verbs | A cloud command would delete, terminate or disable a resource. |
| GP009 | Sensitive writes | Writes to environment, credentials, private-key, wallet and credential-directory paths | A write targets a credential, private-key, wallet or environment file. |
| GP010 | Secret arguments | AWS, GitHub, Stripe, OpenAI or Anthropic key shapes in argument names or values | An argument contains a known secret-key format. |
| GP011 | System security | chmod 777/0777 | Permissions would allow every local user to write and execute the target. |
| GP012 | System security | Recognized firewall disable, stop or flush commands | A command would turn off or flush a local firewall. |
| GP013 | System security | Writes to /etc/hosts, /etc/sudoers or /etc/sudoers.d | A write targets host resolution or sudo authorization settings. |
| GP014 | Package source | Package install from URL or Git source, excluding registry/index options | A package install uses a URL or Git source rather than a registry version. |

The rule catalog and matching implementation, including each ID and default
severity, are in `runtime/guard-pack.cjs`. Command tokenization preserves quoted operators
and separates heredoc data from surrounding commands. Shell consumers and
unquoted substitutions are scanned as executable input. Incomplete shell
parsing also runs the catalog patterns over raw command text conservatively.
Registry/index option values are not interpreted as package sources. Path
normalization is lexical and does not follow symlinks.

## Administrative policy

The only new policy field is the root-level `guardPack` object. It accepts only
`rules`, whose keys are the fixed IDs GP001 through GP014 and inbox-reset-codes and whose values are
`stop`, `warn` or `off`. Custom expressions and additional text are rejected.

```json
{"version":1,"guardPack":{"rules":{"GP003":"warn","GP014":"off"}}}
```

Only a shared team file or published org policy can authorize a downgrade.
An omitted org rule remains STOP, so a lower file cannot relax that default.
A lower file can tighten an explicit administrative downgrade. Personal-only
WARN or OFF settings cannot authorize a downgrade. The existing org merge
rules for capabilities, allowlists, denied tools, caps and mode remain in force.

## Boundaries and verification

This is a bounded literal-command check, not a complete shell interpreter.
It does not expand shell variables, aliases, program-generated commands or
symlink targets. Shell wrappers cover sh/bash/zsh `-c`, common sudo and env
options, and tool inputs named command, cmd or script. Other executable
languages and remote command transports can hide an operation from matching.
Known secret-key formats are checked across argument names and string values.

For Git, shared branch means main or master. The scanner reads local `.git/HEAD`
including worktree pointers and honors `git -C`. Detached HEAD, unsupported Git
directory overrides and unreadable branch evidence produce a WARN in shadow.
No branch name or working-directory path is added to guard-pack metadata.
Scans are limited to 262,144 characters, 1,024 nodes and 12 nested levels;
incomplete scans allow the call with a reason. These checks do not establish
that an unmatched action is safe.

From the source checkout, `node scripts/measure-benign.cjs` scans the checked-in
command corpus without executing it and writes `docs/guard-pack-benign.json`. The report records the
exact count, matches, source hashes, date, Node version and machine. A result
of zero matches describes that corpus only, not a universal false-positive rate.

From the source checkout, `node scripts/measure-overhead.cjs` measures 1,000 real command-policy PreToolUse
invocations using six fixed synthetic calls. It includes Node startup, file IPC
and signing; it excludes one worker warmup and the separate Burn hook and
session startup. Model calls and sockets are forbidden during measurement.
The measured report is `docs/overhead.json`.

The optional `inbox-reset-codes` rule matches email and messaging connector searches for verification codes, one-time codes, password reset and sign-in links. It is off in solo-dev and on in careful and strict. Normal invoice and code-review searches remain unmatched. As with other rules, only the matched ID leaves hook memory.
