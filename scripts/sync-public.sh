#!/usr/bin/env bash
set -euo pipefail

# Copy the reviewed plugin distribution into an existing public Git checkout.
# This command never commits, pushes, installs dependencies, or deploys.
if [[ $# -ne 1 ]]; then
  printf '%s\n' 'Usage: scripts/sync-public.sh PUBLIC_CHECKOUT' >&2
  exit 2
fi
source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
destination="$(cd -- "$1" && pwd -P)"
checkout_root="$(git -C "$destination" rev-parse --show-toplevel)"
checkout_root="$(cd -- "$checkout_root" && pwd -P)"
if [[ "$destination" != "$checkout_root" ]]; then
  printf '%s\n' 'Destination must be the root of an existing Git checkout.' >&2
  exit 2
fi
case "$destination/" in "$source_root/"*) printf '%s\n' 'Destination must be separate from the source package.' >&2; exit 2 ;; esac
case "$source_root/" in "$destination/"*) printf '%s\n' 'Destination must not contain the source package.' >&2; exit 2 ;; esac

sync_tmp="$(mktemp -d "${TMPDIR:-/tmp}/agentguard-public-sync.XXXXXX")"
trap 'rm -rf -- "$sync_tmp"' EXIT
mkdir -p -- "$sync_tmp/package"

# Deliberately enumerate files: an untracked document, key, dump, test scratch
# file, or nested dependency directory is never picked up by a recursive glob.
cat > "$sync_tmp/files.txt" <<'FILES'
.app.json
.gitignore
.agents/plugins/marketplace.json
plugin.json
mcp.json
package.json
package-lock.json
README.md
LICENSE
CHANGELOG.md
scripts/build-compat.cjs
scripts/provision-dependencies.cjs
scripts/sync-public.sh
runtime/license.cjs
runtime/policy-file.cjs
runtime/session-start.cjs
runtime/activate.cjs
runtime/verify.cjs
runtime/client.cjs
runtime/dependencies.cjs
runtime/common.cjs
runtime/control.cjs
runtime/daemon.cjs
runtime/engine.cjs
runtime/mcp.cjs
runtime/mcp-legacy.cjs
runtime/owned-log.cjs
hooks/hooks.json
hooks/session-start.cjs
hooks/burn-gate.cjs
hooks/spend-gate.cjs
hooks/receipt.cjs
config/default-policy.json
skills/agentguard-policy/SKILL.md
skills/agentguard-status/SKILL.md
skills/agentguard-verify/SKILL.md
assets/README.md
assets/logo.svg
assets/icon-32.png
assets/icon-128.png
assets/logo-256.png
assets/logo-512.png
tests/helper-paid-license.cjs
tests/license.test.cjs
tests/lifecycle.test.cjs
tests/engine-license.test.cjs
tests/offline-hooks.test.cjs
tests/burn-hook.test.cjs
tests/compat-output.test.cjs
tests/dependency-provisioning.test.cjs
tests/hooks.test.cjs
tests/mcp.test.cjs
tests/runtime-recovery.test.cjs
tests/packaging.test.cjs
tests/public-sync.test.cjs
tests/fixtures/codex-0.151.0-pretooluse.json
tests/fixtures/codex-plugin-pretooluse.json
FILES
while IFS= read -r relative; do
  case "$relative" in runtime/*|hooks/*|config/*|skills/*|assets/*|scripts/provision-dependencies.cjs)
    printf 'compat/codex-0.154/agentguard/%s\n' "$relative" >> "$sync_tmp/compat-files.txt" ;;
  esac
done < "$sync_tmp/files.txt"
cat >> "$sync_tmp/compat-files.txt" <<'FILES'
compat/codex-0.154/agentguard/.codex-plugin/plugin.json
compat/codex-0.154/agentguard/.mcp.json
compat/codex-0.154/agentguard/.app.json
compat/codex-0.154/agentguard/package.json
compat/codex-0.154/agentguard/package-lock.json
compat/codex-0.154/agentguard/README.md
compat/codex-0.154/agentguard/LICENSE
compat/codex-0.154/agentguard/CHANGELOG.md
compat/codex-0.154/agentguard/COMPATIBILITY.md
FILES
cat "$sync_tmp/compat-files.txt" >> "$sync_tmp/files.txt"

# Validate the complete copy set before changing the destination. Resolving each
# file also rejects a symlinked parent that could copy data outside the package.
node - "$source_root" "$sync_tmp/files.txt" "$destination" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, list, destination] = process.argv.slice(2);
for (const relative of fs.readFileSync(list, 'utf8').trim().split('\n')) {
  const filename = path.join(root, relative);
  if (!fs.lstatSync(filename).isFile() || fs.realpathSync(filename) !== filename) {
    throw new Error(`Sync requires a regular package file: ${relative}`);
  }
  let target = destination;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    target = path.join(target, parts[index]);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) || (index === parts.length - 1 && !stat.isFile())) {
        throw new Error(`Sync destination contains an unsafe path: ${relative}`);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
const catalog = JSON.parse(fs.readFileSync(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'));
const entry = catalog.plugins?.find(item => item.name === 'agentguard');
if (catalog.name !== 'agentguard' || catalog.plugins.length !== 1 || entry?.source?.source !== 'local' ||
    entry.source.path !== './compat/codex-0.154/agentguard' || entry.policy?.installation !== 'AVAILABLE' ||
    entry.policy.authentication !== 'ON_INSTALL' || entry.category !== 'Productivity') {
  throw new Error('The package-local public marketplace catalog is invalid.');
}
require(path.join(root, 'scripts/build-compat.cjs')).check();
NODE

rsync -a --files-from="$sync_tmp/files.txt" "$source_root/" "$sync_tmp/package/"

# Only these package-owned directories are replaced. The repository .git,
# root node_modules, and unrelated root files are outside every deletion scope.
for directory in runtime hooks config skills assets scripts tests compat; do
  mkdir -p -- "$destination/$directory"
  rsync -a --delete "$sync_tmp/package/$directory/" "$destination/$directory/"
done
mkdir -p -- "$destination/.agents/plugins"
rsync -a --delete "$sync_tmp/package/.agents/plugins/" "$destination/.agents/plugins/"
for file in .app.json .gitignore plugin.json mcp.json package.json package-lock.json README.md LICENSE CHANGELOG.md; do
  rsync -a "$sync_tmp/package/$file" "$destination/$file"
done
printf '%s\n' 'Public checkout synchronized. Review the working tree before committing or pushing.'
git -C "$destination" status --short
