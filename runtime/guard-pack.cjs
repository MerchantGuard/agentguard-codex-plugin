'use strict';
// Raw arguments are inspected in this hook process only. Results contain IDs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const RULES = Object.freeze([
  ['GP001', 'remote_shell', '\\b(?:curl|wget)\\b.*\\|\\s*(?:sh|bash|zsh|python(?:3)?)\\b', 'A downloaded response is being executed by a shell or Python.'],
  ['GP002', 'recursive_delete', '\\b(?:rm|Remove-Item)\\b.*(?:-r|--recursive|-Recurse)', 'Recursive deletion targets a root, home, current directory or shallow wildcard.'],
  ['GP003', 'git_history', '\\bgit\\b.*\\bpush\\b.*(?:--force(?:-with-lease)?|-f)', 'A force push targets the shared main or master branch.'],
  ['GP004', 'git_history', '\\bgit\\b.*\\breset\\b.*--hard', 'A hard reset targets a shared branch or a branch whose state is unknown.'],
  ['GP005', 'git_history', '\\bgit\\b.*\\bclean\\b', 'Git clean would remove untracked directories and ignored files.'],
  ['GP006', 'infrastructure', '\\bterraform\\b.*\\b(?:apply|destroy)\\b.*-auto-approve(?:=true)?(?: |$)', 'Terraform would apply infrastructure changes without interactive approval.'],
  ['GP007', 'infrastructure', '\\bkubectl\\b.*\\bdelete\\s+(?:namespace|namespaces|ns)\\b', 'Kubernetes would delete a namespace.'],
  ['GP008', 'infrastructure', '\\b(?:aws|gcloud)\\b.*\\b(?:delete|terminate|disable)[-a-z]*\\b', 'A cloud command would delete, terminate or disable a resource.'],
  ['GP009', 'sensitive_write', '(?:^|[/\\\\])(?:\\.env|credentials|id_rsa|\\.aws|\\.ssh|keychain|wallet)', 'A write targets a credential, private-key, wallet or environment file.'],
  ['GP010', 'secret_argument', '(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:proj-|ant-api[0-9]+-)?[A-Za-z0-9_-]{20,}', 'An argument contains a known secret-key format.'],
  ['GP011', 'system_security', '\\bchmod\\b.*\\b(?:0?777)\\b', 'Permissions would allow every local user to write and execute the target.'],
  ['GP012', 'system_security', '(?:ufw disable|pfctl -d|firewall.*(?:disable|off)|(?:stop|disable).*firewall)', 'A command would turn off or flush a local firewall.'],
  ['GP013', 'system_security', '^/etc/(?:hosts|sudoers(?:/|\\.d/|$))', 'A write targets host resolution or sudo authorization settings.'],
  ['GP014', 'package_source', '(?:https?://|git\\+|git://|git@|github:|gitlab:|bitbucket:|--git|#)', 'A package install uses a URL or Git source rather than a registry version.'],
].map(([id, category, pattern, reason]) => Object.freeze({id, category, pattern, reason, severity: 'stop'})));
const BY_ID = new Map(RULES.map(rule => [rule.id, rule]));
const SHELL = /(?:^|[._])(?:bash|powershell|shell|exec_command|run_command|execute_command|run_shell_command|shell_command)$/i;
const WRITE = /(?:^|[._])(?:write|edit|multiedit|apply_patch|notebookedit|write_file|edit_file|create_file|update_file)$/i;
const SECRET = new RegExp(RULES[9].pattern);
const SENSITIVE = /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|credentials(?:\.[^/\\]*)?|id_rsa(?:\.pub)?|\.aws|\.ssh|(?:[a-z-]+\.)?keychain(?:-db)?|wallet(?:\.[^/\\]*)?)(?:[/\\]|$)/i;
const SYSTEM = /^\/etc\/(?:hosts|sudoers|sudoers\.d)(?:\/|$)/;
const MAX_CHARS = 262144, MAX_NODES = 1024;
function strings(value, result = [], budget = {nodes: 0, chars: 0}, depth = 0) {
  if (++budget.nodes > MAX_NODES || depth > 12) throw new Error('guard_scan_limit');
  if (typeof value === 'string') { budget.chars += value.length; if (budget.chars > MAX_CHARS) throw new Error('guard_scan_limit'); result.push(value); }
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { strings(key, result, budget, depth + 1); strings(item, result, budget, depth + 1); }
  return result;
}
function words(command) {
  const tokens = []; let word = '', quote = null, started = false;
  const flush = () => { if (started) tokens.push({value: word, operator: false}); word = ''; started = false; };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) { quote = null; continue; }
      if (char === '\\' && quote === '"' && /["\\$`\n]/.test(command[index + 1] ?? '')) { if (command[index + 1] !== '\n') word += command[index + 1]; index++; continue; }
      word += char; continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (char === '\\' && /[\s"'|;&<>\\]/.test(command[index + 1] ?? '')) { if (command[index + 1] !== '\n') word += command[index + 1]; started = true; index++; continue; }
    if (/[|;&<>\n]/.test(char)) { flush(); const double = command[index + 1] === char && /[|&<>]/.test(char); tokens.push({value: double ? char + command[++index] : char, operator: true}); continue; }
    if (/\s/.test(char)) { flush(); continue; }
    word += char; started = true;
  }
  if (quote) throw new Error('guard_shell_incomplete');
  flush(); return tokens;
}
function segments(command, depth = 0) {
  if (depth > 2) return [];
  const result = [], current = [];
  for (const token of [...words(command), {value: ';', operator: true}]) {
    if (token.operator && ['|', '||', '&&', '&', ';', '\n'].includes(token.value)) {
      if (current.length) {
        const list = [...current];
        while (list.length) {
          if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(list[0].value)) { list.shift(); continue; }
          const wrapper = path.basename(list[0].value);
          if (!['sudo', 'env', 'command'].includes(wrapper) || wrapper === 'command' && list.some(item => /^-(?:v|V)$/.test(item.value))) break;
          list.shift();
          while (list[0]?.value.startsWith('-')) {
            const flag = list.shift().value; if (flag === '--') break;
            if (wrapper === 'sudo' && /^(?:-[ughpCT]|--user|--group|--host|--prompt|--chdir)$/.test(flag) || wrapper === 'env' && /^(?:-u|--unset|-C|--chdir)$/.test(flag)) list.shift();
          }
        }
        if (list.length) {
          const values = list.map(item => item.value); values[0] = path.basename(values[0]);
          result.push({words: values, after: token.value, redirects: list.flatMap((item, index) => item.operator && ['>', '>>'].includes(item.value) && list[index + 1] ? [list[index + 1].value] : [])});
          if (/^(?:sh|bash|zsh)$/.test(values[0])) { const index = values.findIndex(value => /^-[a-z]*c[a-z]*$/.test(value)); if (index >= 0 && values[index + 1]) result.push(...segments(values[index + 1], depth + 1)); }
        }
      }
      current.length = 0;
    } else current.push(token);
  }
  return result;
}
function shallowDelete(value) {
  value = /^[A-Za-z]:[\\/]/.test(value) ? path.win32.normalize(value) : path.posix.normalize(value);
  value = value.replace(/[\\/]+$/, '') || '/';
  if (/^(?:\/|~|\$HOME|\$\{HOME\}|\.|\.\.|[A-Za-z]:[\\/]?)$/.test(value)) return true;
  if (value === path.normalize(os.homedir()).replace(/[\\/]+$/, '')) return true;
  return /[*?]|\[[^\]]+\]/.test(value) && value.replace(/^\$\{?HOME\}?|^~|^[A-Za-z]:/, '').split(/[\\/]/).filter(part => part && part !== '.').length <= 2;
}
function cloudOperation(list) {
  const positional = [];
  for (let index = 1; index < list.length; index++) {
    const value = list[index];
    if (value.startsWith('-')) {
      if (!value.includes('=') && /^(?:--profile|--region|--endpoint-url|--output|--query|--project|--account|--configuration|--billing-project|--impersonate-service-account|--flags-file)$/.test(value)) index++;
      continue;
    }
    positional.push(value);
  }
  if (list[0] === 'aws') return positional[1] ?? '';
  // Gcloud has variable-depth command groups. Stop at the first recognized
  // operation so an object named "delete" is never mistaken for an operation.
  return positional.find(value => /^(?:delete|terminate|disable|describe|list|get|show|create|update|add|remove|set|unset|enable|start|stop|restart|submit|deploy|export|import|print|login|activate|revoke|ssh|scp|cp|ls)(?:-[a-z]+)*$/.test(value)) ?? '';
}
function chmodMode(list) {
  for (let index = 1; index < list.length; index++) {
    if (list[index] === '--reference' || list[index].startsWith('--reference=')) return '';
    if (list[index] === '--') return list[index + 1] ?? '';
    if (!list[index].startsWith('-')) return list[index];
  }
  return '';
}
function readGitReference(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw new Error('guard_git_reference_invalid');
    const buffer = Buffer.alloc(4097), bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 4096) throw new Error('guard_git_reference_invalid');
    return buffer.toString('utf8', 0, bytes);
  } finally { fs.closeSync(fd); }
}
function branchState(cwd) {
  if (!cwd || !path.isAbsolute(cwd)) return null;
  let directory = cwd;
  for (let level = 0; level < 16; level++) {
    const candidate = path.join(directory, '.git');
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() && !stat.isFile()) return null;
      let git = candidate;
      try {
        if (stat.isFile()) { const match = /^gitdir: ([^\r\n]+)\s*$/.exec(readGitReference(candidate)); if (!match) return null; git = path.resolve(directory, match[1]); }
        const ref = /^ref: refs\/heads\/([^\r\n]+)\s*$/.exec(readGitReference(path.join(git, 'HEAD')))?.[1];
        return ref ? /^(?:main|master)$/.test(ref) : null;
      } catch { return null; }
    } catch (error) { if (error.code !== 'ENOENT') return null; }
    const parent = path.dirname(directory); if (parent === directory) return null; directory = parent;
  }
  return null;
}
function writeTargets(tool, input, commands) {
  const targets = [];
  if (WRITE.test(tool)) {
    const visit = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 12) return;
      for (const [key, item] of Object.entries(value)) {
        if (/^(?:path|file_path|filepath|filename|file|notebook_path)$/i.test(key) && typeof item === 'string') targets.push(item);
        if (typeof item === 'string' && /^(?:patch|input|diff)$/i.test(key)) for (const match of item.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) targets.push(match[1]);
        if (item && typeof item === 'object') visit(item, depth + 1);
      }
    };
    if (typeof input === 'string') for (const match of input.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) targets.push(match[1]);
    else visit(input);
  }
  for (const {words: list, redirects} of commands) {
    targets.push(...redirects);
    const name = list[0].toLowerCase();
    if (['tee', 'touch', 'truncate'].includes(name)) targets.push(...list.slice(1).filter(value => !value.startsWith('-')));
    if (['cp', 'mv', 'install'].includes(name) && list.length > 2) {
      const at = list.findIndex(value => value === '-t' || value === '--target-directory');
      targets.push(at >= 0 && list[at + 1] ? list[at + 1] : list.find(value => value.startsWith('--target-directory='))?.slice(19) ?? list.at(-1));
    }
    if (['sed', 'perl'].includes(name) && list.some(value => /^-[a-z]*i/.test(value))) targets.push(list.at(-1));
    if (/^(?:set-content|add-content|out-file|new-item)$/i.test(name)) { const at = list.findIndex(value => /^(?:-path|-literalpath|-filepath)$/i.test(value)); if (at >= 0 && list[at + 1]) targets.push(list[at + 1]); }
  }
  return targets.map(target => target.replace(/\\/g, '/')).map(target => path.posix.normalize(target));
}
function scanGuardPack(tool, input, options = {}) {
  const found = new Set(); let reason;
  try {
    const values = strings(input);
    if (values.some(value => SECRET.test(value))) found.add('GP010');
    const commandValues = SHELL.test(tool) ? (typeof input === 'string' ? [input] : [input?.command, input?.cmd, input?.script].flat().filter(value => typeof value === 'string')) : [];
    const commands = commandValues.flatMap(value => segments(value));
    const sharedBranch = list => {
      let cwd = options.cwd, uncertain = false;
      for (let index = 1; index < list.length; index++) {
        if (list[index] === '-C') { if (!cwd || !list[index + 1]) { uncertain = true; break; } cwd = path.resolve(cwd, list[++index]); }
        else if (list[index].startsWith('--git-dir') || list[index].startsWith('--work-tree')) uncertain = true;
      }
      const shared = uncertain ? null : options.sharedBranch === undefined ? branchState(cwd) : options.sharedBranch;
      if (shared === null) reason = 'guard_branch_unknown'; return shared !== false;
    };
    for (const [index, command] of commands.entries()) {
      const list = command.words, name = list[0].toLowerCase(), text = list.join(' ');
      if (list.some(value => /^--dry-run(?:=(?!false$|none$).*)?$/.test(value))) continue;
      if (/^(?:curl|wget)$/.test(name) && command.after === '|' && /^(?:sh|bash|zsh|python(?:3)?)$/.test(commands[index + 1]?.words[0] ?? '')) found.add('GP001');
      if ((name === 'rm' && list.some(value => /^-[a-z]*r|^--recursive$/i.test(value)) || name === 'remove-item' && list.some(value => /^-recurse$/i.test(value))) && list.slice(1).some(shallowDelete)) found.add('GP002');
      if (name === 'git') {
        if (list.includes('push')) {
          const arguments_ = list.slice(list.indexOf('push') + 1);
          const forced = arguments_.some(value => /^--force(?:-with-lease)?(?:=|$)|^-f$/.test(value));
          const destinations = arguments_.filter(value => !value.startsWith('-'));
          const refs = destinations.slice(1);
          if (refs.some(value => (forced || value.startsWith('+')) && /^(?:main|master)$/.test(value.replace(/^\+/, '').split(':').at(-1).replace(/^refs\/heads\//, '')))
            || (forced && destinations.length <= 1 || refs.some(value => /^(?:\+HEAD|HEAD)$/.test(value) && (forced || value.startsWith('+')))) && sharedBranch(list)) found.add('GP003');
        }
        if (list.includes('reset') && list.includes('--hard') && sharedBranch(list)) found.add('GP004');
        if (list.includes('clean')) { const flags = list.filter(value => /^-[^-]/.test(value)).join(''); if (!flags.includes('n') && (flags.includes('f') || list.includes('--force')) && flags.includes('d') && flags.includes('x')) found.add('GP005'); }
      }
      if (name === 'terraform' && list.some(value => /^(?:apply|destroy)$/.test(value)) && list.some(value => /^-auto-approve(?:=true)?$/.test(value))) found.add('GP006');
      if (name === 'kubectl' && /\bdelete (?:namespace|namespaces|ns)\b/.test(text)) found.add('GP007');
      if (/^(?:aws|gcloud)$/.test(name) && /^(?:delete|terminate|disable)(?:[-a-z]*)$/.test(cloudOperation(list))) found.add('GP008');
      if (name === 'chmod' && /^0?777$/.test(chmodMode(list))) found.add('GP011');
      if (name === 'ufw' && list.includes('disable') || name === 'pfctl' && list.includes('-d') || name === 'iptables' && list.includes('-F')
        || /^(?:systemctl|service)$/.test(name) && list.some(value => /^(?:stop|disable)$/.test(value)) && list.some(value => /^(?:ufw|firewalld|iptables)(?:\.service)?$/.test(value))
        || name === 'netsh' && /advfirewall .*state off/i.test(text) || name === 'socketfilterfw' && /--setglobalstate off/.test(text)
        || name === 'set-netfirewallprofile' && /-enabled (?:false|\$false)/i.test(text)) found.add('GP012');
      const installing = /^(?:npm|pnpm|yarn|pip|pip3|uv|cargo)$/.test(name) && list.some(value => /^(?:install|add|i)$/.test(value));
      const sources = [];
      for (let index = 1; index < list.length; index++) {
        if (/^(?:--registry|--index-url|--extra-index-url|--trusted-host)$/.test(list[index]) || /^(?:pip|pip3|uv)$/.test(name) && list[index] === '-i') { index++; continue; }
        if (/^(?:--registry|--index-url|--extra-index-url|--trusted-host)=/.test(list[index]) || /^(?:\.{1,2}[\\/]|[\\/]|file:|link:|workspace:)/.test(list[index])) continue;
        sources.push(list[index]);
      }
      if (installing && sources.some(value => /(?:https?:\/\/|git\+|git:\/\/|git@|github:|gitlab:|bitbucket:|^--git$|#[A-Za-z0-9])/.test(value) || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))) found.add('GP014');
    }
    for (const target of writeTargets(tool, input, commands)) { if (SENSITIVE.test(target)) found.add('GP009'); if (SYSTEM.test(target)) found.add('GP013'); }
  } catch { reason = 'guard_scan_incomplete'; }
  return {ruleIds: [...found].sort(), ...(reason ? {reason} : {})};
}
function guardResult(ids, config = {}, mode = 'shadow') {
  if (!Array.isArray(ids) || ids.length > RULES.length || ids.some(id => !BY_ID.has(id))) throw new Error('guard_rule_ids_invalid');
  const matches = [...new Set(ids)].map(id => { const configured = config.rules?.[id] ?? 'stop'; if (!['stop', 'warn', 'off'].includes(configured)) throw new Error('guard_policy_invalid'); return {id, action: configured === 'stop' && mode !== 'enforce' ? 'warn' : configured}; });
  if (matches.some(match => !['stop', 'warn', 'off'].includes(match.action))) throw new Error('guard_policy_invalid');
  const active = matches.filter(match => match.action !== 'off');
  const stop = mode === 'enforce' && active.some(match => match.action === 'stop');
  return {matches, stop, warning: active.length > 0 && !stop,
    message: active.map(match => `AgentGuard ${mode === 'enforce' && match.action === 'stop' ? 'STOP' : 'WARN'} ${match.id}: ${BY_ID.get(match.id).reason}`).join(' ')};
}
module.exports = {RULES, scanGuardPack, guardResult, branchState};
