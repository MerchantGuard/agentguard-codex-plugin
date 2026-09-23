'use strict';
// Ordinary spellings of the built-in command categories, from the review of
// plugin/policy-ux-and-solo-sync-2026-09. Each entry pins the category the
// scanner must report. Strings are scanned only; nothing here is run.
const spellings = [
  ['force-push', 'git push --force origin feature'], ['force-push', 'git push -fu origin feature'], ['force-push', 'git push -uf origin feature'],
  ['force-push', 'git push --mirror'], ['force-push', '\\git push --force origin feature'], ['force-push', 'eval "git push --force origin feature"'],
  ['force-push', 'timeout 5 git push --force origin feature'], ['force-push', 'nohup git push --force'], ['force-push', 'exec git push --force'],
  ['force-push', 'time git push --force'], ['force-push', 'sh -c "git push --force"'], ['force-push', 'xargs git push --force < /dev/null'],
  ['deploy', 'vercel deploy'], ['deploy', 'vercel --prod'], ['deploy', 'vercel .'], ['deploy', 'vc --prod'], ['deploy', 'bunx vercel deploy'],
  ['deploy', 'firebase deploy'], ['deploy', 'npm run deploy'], ['deploy', 'fly deploy'],
  ['outside-workspace-delete', 'rm -rf /var/tmp/x'], ['outside-workspace-delete', 'cd ~ && rm -rf Documents/x'], ['outside-workspace-delete', 'cd $HOME && rm -rf Documents/x'],
  ['outside-workspace-delete', 'cd "$HOME" && rm -rf x'], ['outside-workspace-delete', 'env -C /var/tmp rm -rf x'], ['outside-workspace-delete', 'sudo --chdir=/var/tmp rm -rf x'],
  ['outside-workspace-delete', '(cd /var/tmp; rm -rf x)'], ['outside-workspace-delete', 'pushd /var/tmp && rm -rf x'], ['outside-workspace-delete', 'find /var/tmp/x -delete'],
  ['outside-workspace-delete', 'unlink /var/tmp/x'], ['outside-workspace-delete', 'rmdir /var/tmp/x'],
  ['package-publish', 'npm publish'], ['package-publish', 'npm publish --tag next'], ['package-publish', 'bun publish'], ['package-publish', 'gh release create v1'], ['package-publish', 'docker push img'],
  // Backslashes the shell removes, a second shell name, and find with two pre-path options.
  ['force-push', 'git push --\\force origin feature'], ['force-push', 'g\\it push -\\f origin feature'], ['force-push', 'dash -c "git push --force"'],
  ['outside-workspace-delete', 'find -H -L /var/tmp -delete'],
  // Shell keywords in front of the command, and find deleting through -exec or without a start path.
  ['outside-workspace-delete', '{ cd /var/tmp; }; rm -rf x'], ['outside-workspace-delete', 'if true; then rm -rf /var/tmp/x; fi'], ['outside-workspace-delete', 'for f in a; do rm -rf /var/tmp/x; done'],
  ['force-push', 'while :; do git push --force origin x; done'], ['force-push', '{ git push --force origin x; }'], ['force-push', 'f() { git push --force origin x; }; f'], ['force-push', '! git push -f origin x'],
  ['outside-workspace-delete', 'find /var/tmp -name x -exec rm -rf {} +'], ['outside-workspace-delete', 'find -f /var/tmp -delete'], ['outside-workspace-delete', 'cd $X && find -delete'],
];
// Ordinary local work that must stay unclassified under the same rules.
const ordinary = ['git push origin feature', 'git push -u origin feature', 'rm ./build/output.txt', 'rm -rf build/temp', 'vercel env ls', 'vercel logs', 'npm run build',
  'gh release list', 'find . -name "*.tmp"', 'timeout 5 npm test', 'npm test', 'echo deploy', '(cd build && ls)', 'pushd build && ls && popd',
  'rm -rf ./node_modules', 'find . -name "*.log" -delete', "eval \"echo it's\"", 'vercel env pull', 'gh release view v1', 'ls *.js'];
module.exports = {spellings, ordinary};
