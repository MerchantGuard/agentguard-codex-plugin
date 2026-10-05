'use strict';
// Builds the AgentGuard notifier app from the Swift sources in this folder, on the person's own Mac,
// into ~/Library/Application Support/AgentGuard/AgentGuard.app. Nothing prebuilt ships in the plugin:
// the app is compiled from readable source, signed locally (ad hoc), and rebuilt when the source changes.
// Needs the Xcode command line tools (swiftc). Without them the plugin keeps the AppleScript notification.
//
//   node runtime/notifier/build.cjs            builds (or refreshes) the app, prints its path
//   require(...).notifierBinary(options)       path of a current build, or null
//   require(...).startBuild(options)           starts a detached build and returns at once
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync, spawn} = require('node:child_process');

const SOURCES = ['main.swift', 'make-icon.swift', 'Info.plist'].map(name => path.join(__dirname, name));
const SIZES = [16, 32, 128, 256, 512];

function appDir(options = {}) {
  return options.appDir ?? path.join(options.home ?? os.homedir(), 'Library', 'Application Support', 'AgentGuard', 'AgentGuard.app');
}
function binaryPath(dir) { return path.join(dir, 'Contents', 'MacOS', 'agentguard-notifier'); }
function stampPath(dir) { return path.join(dir, 'Contents', 'Resources', 'source.sha256'); }
function sourceHash() {
  const hash = crypto.createHash('sha256');
  for (const file of SOURCES) hash.update(path.basename(file)).update('\0').update(fs.readFileSync(file)).update('\0');
  return hash.digest('hex');
}
// The current build, or null when there is none or the source changed since it was built.
function notifierBinary(options = {}) {
  const dir = appDir(options);
  try {
    if (fs.readFileSync(stampPath(dir), 'utf8').trim() !== sourceHash()) return null;
    fs.accessSync(binaryPath(dir), fs.constants.X_OK);
    return binaryPath(dir);
  } catch { return null; }
}
// xcrun finds swiftc and sets the SDK; calling the toolchain binary directly cannot load the standard library.
function swiftc() {
  try { return execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], {encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore']}).trim() ? '/usr/bin/xcrun' : null; }
  catch { return null; }
}
function run(file, args, options = {}) { return execFileSync(file, args, {stdio: ['ignore', 'pipe', 'pipe'], timeout: options.timeout ?? 180000}); }
function compile(compiler, source, output, frameworks) {
  run(compiler, ['swiftc', '-swift-version', '5', '-O', source, '-o', output, ...frameworks.flatMap(name => ['-framework', name])]);
}

// Builds synchronously. Returns the binary path. Throws when a step fails; the caller treats that as "no app".
function build(options = {}) {
  const compiler = options.swiftc ?? swiftc();
  if (!compiler) throw new Error('swiftc not found: install the Xcode command line tools');
  const dir = appDir(options);
  const version = options.version ?? require('../../package.json').version;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-notifier-build-'));
  try {
    const stage = path.join(work, 'AgentGuard.app');
    fs.mkdirSync(path.join(stage, 'Contents', 'MacOS'), {recursive: true});
    fs.mkdirSync(path.join(stage, 'Contents', 'Resources'), {recursive: true});
    const plist = fs.readFileSync(path.join(__dirname, 'Info.plist'), 'utf8')
      .replace('__VERSION__', version).replace('__BUILD__', String(Math.floor(Date.now() / 1000)));
    fs.writeFileSync(path.join(stage, 'Contents', 'Info.plist'), plist);
    // The icon is drawn from source too: the site's mark on Apple's rounded-square grid.
    compile(compiler, path.join(__dirname, 'make-icon.swift'), path.join(work, 'make-icon'), ['AppKit']);
    run(path.join(work, 'make-icon'), [path.join(work, 'icon-1024.png')]);
    const iconset = path.join(work, 'AppIcon.iconset'); fs.mkdirSync(iconset);
    for (const size of SIZES) {
      run('/usr/bin/sips', ['-z', String(size), String(size), path.join(work, 'icon-1024.png'), '--out', path.join(iconset, `icon_${size}x${size}.png`)]);
      run('/usr/bin/sips', ['-z', String(size * 2), String(size * 2), path.join(work, 'icon-1024.png'), '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)]);
    }
    run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(stage, 'Contents', 'Resources', 'AppIcon.icns')]);
    compile(compiler, path.join(__dirname, 'main.swift'), binaryPath(stage), ['AppKit', 'UserNotifications']);
    fs.writeFileSync(stampPath(stage), sourceHash() + '\n');
    run('/usr/bin/codesign', ['--force', '-s', '-', stage]);
    // Replace the installed app in one move; macOS keeps the notification permission by bundle id.
    fs.mkdirSync(path.dirname(dir), {recursive: true});
    const previous = dir + '.previous';
    fs.rmSync(previous, {recursive: true, force: true});
    if (fs.existsSync(dir)) fs.renameSync(dir, previous);
    fs.renameSync(stage, dir);
    fs.rmSync(previous, {recursive: true, force: true});
    try { run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', dir], {timeout: 30000}); } catch {}
    return binaryPath(dir);
  } finally {
    fs.rmSync(work, {recursive: true, force: true});
  }
}

// Starts a build in the background so a hook never waits for the compiler. One build at a time per app dir.
function startBuild(options = {}) {
  const dir = appDir(options);
  const lock = dir + '.building';
  try {
    const started = Number(fs.readFileSync(lock, 'utf8'));
    if (Date.now() - started < 10 * 60 * 1000) return false;
  } catch {}
  try {
    fs.mkdirSync(path.dirname(dir), {recursive: true});
    fs.writeFileSync(lock, String(Date.now()));
    const child = (options.spawn ?? spawn)(process.execPath, [__filename, '--app-dir', dir], {detached: true, stdio: 'ignore'});
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch { return false; }
}

if (require.main === module) {
  const index = process.argv.indexOf('--app-dir');
  const options = index > 0 ? {appDir: process.argv[index + 1]} : {};
  const lock = appDir(options) + '.building';
  try { process.stdout.write(build(options) + '\n'); }
  catch (error) { process.stderr.write(`notifier build failed: ${error.message}\n`); process.exitCode = 1; }
  finally { fs.rmSync(lock, {force: true}); }
}

module.exports = {appDir, binaryPath, build, notifierBinary, sourceHash, startBuild, swiftc};
