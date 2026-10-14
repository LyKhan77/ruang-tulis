#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, readFileSync, writeFileSync } from 'node:fs';
import { access, mkdir, readFile, readdir, realpath, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 5173;
const URL = `http://${HOST}:${PORT}/`;
const LOCK = '.start-local.lock';
const MARKER = '.start-local-fingerprint';
const HELP = `Start the document editor at ${URL}

Usage: npm start -- [--no-open] [--help]
       node scripts/start-local.mjs [--no-open] [--help]

  --no-open  Start the same server without opening a browser.
  --help     Show this help without checking npm or installing dependencies.

Requires Node.js >=22.12.0 and npm. Install the current Node.js LTS release.
Dependencies are installed locally with npm ci --include=dev --include=optional when needed.
The host and port are fixed. Stop this launcher with Ctrl+C.
`;

export class LauncherError extends Error {
  constructor(message, exitCode = 1, options) {
    super(message, options);
    this.name = 'LauncherError';
    this.exitCode = exitCode;
  }
}

export function assertNodeVersion(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 12)) {
    throw new LauncherError(`Node.js ${version} is unsupported. Node.js >=22.12.0 is required; install the current Node.js LTS release (which includes npm).`);
  }
}

export function parseFlags(argv) {
  const result = { help: false, open: true };
  for (const arg of argv) {
    if (arg === '--help') result.help = true;
    else if (arg === '--no-open') result.open = false;
    else throw new LauncherError(`Unknown argument: ${arg}. Use --help; host and port cannot be changed.`);
  }
  return result;
}

export function resolveProjectRoot(moduleUrl = import.meta.url) {
  return path.dirname(path.dirname(fileURLToPath(moduleUrl)));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function computeFingerprint(lockText, pkg) {
  const declarations = {};
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
    'peerDependenciesMeta', 'bundledDependencies', 'bundleDependencies', 'overrides', 'workspaces',
    'engines', 'packageManager', 'os', 'cpu']) {
    if (pkg[key] !== undefined) declarations[key] = pkg[key];
  }
  // Root install hooks can change the installed tree; unrelated launcher/test scripts cannot.
  declarations.installScripts = Object.fromEntries(['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']
    .filter((key) => pkg.scripts?.[key] !== undefined).map((key) => [key, pkg.scripts[key]]));
  return createHash('sha256').update(JSON.stringify({
    schema: 2, lockText, declarations: canonical(declarations),
    platform: process.platform, arch: process.arch, nodeMajor: process.versions.node.split('.')[0],
  })).digest('hex');
}

async function isFile(file) {
  try {
    await access(file, constants.R_OK);
    return (await stat(file)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function viteCli(root) {
  return path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
}

async function viteInstalled(root, platform) {
  return await isFile(viteCli(root)) && await isFile(path.join(root, 'node_modules', '.bin', platform === 'win32' ? 'vite.cmd' : 'vite'));
}

export async function needsInstall(root, fingerprint, platform = process.platform) {
  if (!await viteInstalled(root, platform)) return true;
  try {
    return (await readFile(path.join(root, 'node_modules', MARKER), 'utf8')).trim() !== fingerprint;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

const RUNTIME_CHECK = String.raw`
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[1];
const require = createRequire(path.join(root, 'node_modules', 'vite', 'package.json'));
const vite = await import(pathToFileURL(path.join(root, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);
if (typeof vite.createServer !== 'function') throw new Error('Vite runtime is unavailable');
const { rollup } = require('rollup');
const id = '\0launcher-readiness';
const bundle = await rollup({
  input: id,
  plugins: [{
    name: 'launcher-readiness',
    resolveId: (source) => source === id ? id : null,
    load: (source) => source === id ? 'export const launcherReady = true;' : null,
  }],
});
try {
  const result = await bundle.generate({ format: 'es' });
  if (!result.output.some((entry) => entry.type === 'chunk' && entry.code.includes('launcherReady'))) {
    throw new Error('Rollup native runtime produced no output');
  }
} finally {
  await bundle.close();
}
const esbuild = require('esbuild');
try {
  const result = await esbuild.transform('export const launcherReady = true;', { loader: 'js' });
  if (!result.code.includes('launcherReady')) throw new Error('esbuild native runtime produced no output');
} finally {
  esbuild.stop();
}
`;

export async function validateRuntime(root, childOptions = {}) {
  try {
    await runChild(process.execPath, ['--input-type=module', '--eval', RUNTIME_CHECK, root], {
      ...childOptions, cwd: root,
    });
  } catch (error) {
    if (childOptions.abortSignal?.aborted) throw childOptions.abortSignal.reason;
    throw new LauncherError(`Vite/Rollup/esbuild runtime readiness failed: ${error.message}. Check native/optional dependencies and npm configuration before retrying.`, error.exitCode ?? 1, { cause: error });
  }
}

export function npmCommand(npmCli, execPath = process.execPath) {
  if (!/(?:^|[\\/])npm-cli\.js$/.test(npmCli)) {
    throw new LauncherError('npm must be invoked through a local npm-cli.js, not a .cmd shell command.');
  }
  return { file: execPath, args: [npmCli, 'ci', '--include=dev', '--include=optional'] };
}

export async function findNpmCli({ execPath = process.execPath, env = process.env, platform = process.platform } = {}) {
  const candidates = [];
  if (env.npm_execpath && /(?:^|[\\/])npm-cli\.js$/.test(env.npm_execpath)) candidates.push(env.npm_execpath);
  const executableDir = path.dirname(execPath);
  const directories = [executableDir, ...(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)];
  for (const dir of directories) {
    candidates.push(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    candidates.push(path.resolve(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    if (platform !== 'win32') {
      try {
        const resolved = await realpath(path.join(dir, 'npm'));
        if (/(?:^|[\\/])npm-cli\.js$/.test(resolved)) candidates.push(resolved);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      }
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    if (await isFile(candidate)) return candidate;
  }
  throw new LauncherError('npm is required but its npm-cli.js could not be found. Install the current Node.js LTS release with npm included, then reopen your terminal. No global package installation is needed.');
}

export function assertPortAvailable({ host = HOST, port = PORT, createServer = () => net.createServer() } = {}) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new LauncherError(`The loopback port ${port} is already in use. Stop the existing editor or the application using that port, then retry. This launcher requires ${URL}; it will not kill another process or choose a different port.`));
      } else {
        reject(new LauncherError(`Cannot check ${host}:${port}: ${error.message}`, 1, { cause: error }));
      }
    });
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close((error) => error ? reject(error) : resolve());
    });
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM, unsupported probes, and ambiguous errors must never authorize removal.
    return error.code !== 'ESRCH';
  }
}

function validOwner(owner) {
  return owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 &&
    typeof owner.token === 'string' && /^[a-zA-Z0-9-]+$/.test(owner.token) && typeof owner.hostname === 'string' &&
    (owner.phase === undefined || ['idle', 'spawning', 'running'].includes(owner.phase)) &&
    (owner.childPid === undefined || owner.childPid === null || (Number.isSafeInteger(owner.childPid) && owner.childPid > 0)) &&
    (owner.childGroupId === undefined || owner.childGroupId === null ||
      (Number.isSafeInteger(owner.childGroupId) && owner.childGroupId > 0 && owner.childGroupId === owner.childPid));
}

function lockInstructions(dir) {
  return new LauncherError(`Cannot safely recover launcher lock ${dir}. Inspect it and verify that no launcher, npm installation, or editor server is running before manually removing this directory. Do not remove an active lock.`);
}

export async function acquireLock(root, { pid = process.pid, isAlive = pidAlive, isGroupAlive = processGroupAlive, abortSignal } = {}) {
  const dir = path.join(root, LOCK);
  const recoveryDir = path.join(dir, 'recovery');
  const localHost = hostname();
  const active = (owner) => isAlive(owner.pid) || (owner.childPid && isAlive(owner.childPid)) ||
    (owner.childGroupId && isGroupAlive(owner.childGroupId));
  const readOwner = async () => {
    const entries = await readdir(dir);
    const files = entries.filter((name) => /^owner-[a-zA-Z0-9-]+\.json$/.test(name));
    if (files.length !== 1 || entries.some((name) => name !== files[0] && name !== 'recovery')) {
      throw lockInstructions(dir);
    }
    const file = path.join(dir, files[0]);
    const owner = JSON.parse(await readFile(file, 'utf8'));
    if (!validOwner(owner) || files[0] !== `owner-${owner.token}.json` || owner.hostname !== localHost) {
      throw lockInstructions(dir);
    }
    return { file, owner };
  };
  let created = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (abortSignal?.aborted) throw abortSignal.reason;
    try {
      await mkdir(dir);
      created = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let snapshot;
    try { snapshot = await readOwner(); }
    catch { throw lockInstructions(dir); }
    const { file, owner } = snapshot;
    if (active(owner)) throw new LauncherError(`Another launcher or its child is active (launcher PID ${owner.pid}). Wait for it or stop it from its own terminal; the lock at ${dir} was left intact.`);
    // A crash between spawn and recording the PID is ambiguous, even with a dead parent.
    if (owner.phase === 'spawning') throw lockInstructions(dir);
    try { await mkdir(recoveryDir); }
    catch (error) {
      if (['ENOENT', 'EEXIST'].includes(error.code)) throw lockInstructions(dir);
      throw error;
    }
    try {
      if (abortSignal?.aborted) throw abortSignal.reason;
      const current = await readOwner();
      if (current.file !== file || current.owner.token !== owner.token || current.owner.pid !== owner.pid ||
          current.owner.phase === 'spawning') throw lockInstructions(dir);
      if (active(current.owner)) throw new LauncherError(`A recorded launcher or child PID is active; the lock at ${dir} was left intact.`);
      // Delete only the stale token's filename. A different owner file is never targeted.
      await unlink(file);
    } finally {
      await rmdir(recoveryDir);
    }
    // Never recursively remove a lock. A competing owner/recovery makes this fail closed.
    try { await rmdir(dir); }
    catch { throw lockInstructions(dir); }
  }
  if (!created) throw lockInstructions(dir);
  const owner = { pid, token: randomUUID(), hostname: localHost, childPid: null, childGroupId: null, phase: 'idle' };
  const ownerFile = path.join(dir, `owner-${owner.token}.json`);
  try {
    writeFileSync(ownerFile, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rmdir(dir).catch(() => {});
    throw error;
  }
  const update = () => {
    const current = JSON.parse(readFileSync(ownerFile, 'utf8'));
    if (current.token !== owner.token || current.pid !== owner.pid) throw lockInstructions(dir);
    writeFileSync(ownerFile, JSON.stringify(owner), { mode: 0o600 });
  };
  return {
    beginSpawn() {
      owner.phase = 'spawning';
      owner.childPid = null;
      owner.childGroupId = null;
      update();
    },
    setChild(childPid) {
      owner.childPid = childPid ?? null;
      owner.childGroupId = childPid && process.platform !== 'win32' ? childPid : null;
      owner.phase = childPid ? 'running' : 'idle';
      update();
    },
    async release() {
      let current;
      try { current = JSON.parse(await readFile(ownerFile, 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') return;
        throw lockInstructions(dir);
      }
      if (current.token !== owner.token || current.pid !== owner.pid) return;
      await unlink(ownerFile);
      try { await rmdir(dir); }
      catch { throw lockInstructions(dir); }
    },
  };
}

function interruption(signal) {
  return new LauncherError(`Stopped by ${signal}.`, signal === 'SIGINT' ? 130 : 143);
}

const ownedGroups = new WeakMap();

function processGroupAlive(groupId) {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function stopOwnedChild(child, signal) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => child.kill(signal));
    killer.once('close', (code) => { if (code !== 0) child.kill(signal); });
  } else {
    // This identity is enrolled only for a child spawned into its own detached group.
    // Do not depend on the leader still being alive: npm's scripts can outlive it.
    const groupId = ownedGroups.get(child);
    if (!groupId) return;
    try { process.kill(-groupId, signal); }
    catch (error) {
      if (error.code === 'ESRCH') ownedGroups.delete(child);
      else throw error;
    }
  }
}

export function runChild(file, args, {
  cwd, spawnImpl = spawn, signalSource = process, abortSignal,
  beforeSpawn = () => {}, onSpawn = () => {}, stopChild = stopOwnedChild,
  platform = process.platform,
  probeGroup = stopChild === stopOwnedChild ? processGroupAlive : () => false,
  shutdownGraceMs = 5000, groupPollMs = 50,
} = {}) {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) return reject(abortSignal.reason);
    let child;
    let groupId;
    let leaderClosed = false;
    let failure;
    let timer;
    let groupPoll;
    let settled = false;
    let stopping = false;
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(groupPoll);
      if (child) ownedGroups.delete(child);
      signalSource?.removeListener('SIGINT', onInt);
      signalSource?.removeListener('SIGTERM', onTerm);
      abortSignal?.removeEventListener('abort', onAbort);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const stop = (error) => {
      if (settled) return;
      failure ??= error;
      const force = stopping;
      stopping = true;
      try { stopChild(child, force ? 'SIGKILL' : 'SIGTERM'); }
      catch (stopError) { failure = new LauncherError(`Could not stop owned child group ${groupId ?? child.pid}: ${stopError.message}`); }
      if (!timer && !settled) {
        timer = setTimeout(() => {
          try { stopChild(child, 'SIGKILL'); }
          catch { /* Keep the lock while an owned group might still be alive. */ }
        }, shutdownGraceMs);
        timer.unref();
      }
    };
    const completeWhenDrained = () => {
      if (settled || !leaderClosed) return;
      let groupLives = false;
      if (groupId && (probeGroup !== processGroupAlive || ownedGroups.has(child))) {
        try { groupLives = probeGroup(groupId); }
        catch { groupLives = true; } // Ambiguous/EPERM probes never authorize lock release.
      }
      if (!groupLives) {
        finish(failure);
        return;
      }
      if (!groupPoll) {
        // Keep polling referenced after the leader closes. Its descendants alone
        // must not let Node exit or let the lock be released before escalation.
        groupPoll = setInterval(completeWhenDrained, groupPollMs);
      }
      if (!stopping) stop();
    };
    const onInt = () => stop(interruption('SIGINT'));
    const onTerm = () => stop(interruption('SIGTERM'));
    const onAbort = () => stop(abortSignal.reason);
    try {
      beforeSpawn();
      if (abortSignal?.aborted) return finish(abortSignal.reason);
      child = spawnImpl(file, args, {
        cwd, stdio: 'inherit', shell: false,
        detached: platform !== 'win32', windowsHide: false,
      });
      if (platform !== 'win32' && child.pid) {
        groupId = child.pid;
        ownedGroups.set(child, groupId);
      }
      child.on('error', (error) => {
        if (settled || stopping) return;
        const wrapped = new LauncherError(`Unable to run ${file}: ${error.message}`, 1, { cause: error });
        if (child.pid) stop(wrapped);
        else finish(wrapped);
      });
      child.once('close', (code, signal) => {
        leaderClosed = true;
        failure ??= code === 0 ? undefined : new LauncherError(
          `${path.basename(file)} ${signal ? `was terminated by ${signal}` : `exited with code ${code}`}.`,
          Number.isInteger(code) && code > 0 ? code : 1,
        );
        completeWhenDrained();
      });
      signalSource?.on('SIGINT', onInt);
      signalSource?.on('SIGTERM', onTerm);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      if (child.pid) {
        try { onSpawn(child); }
        catch (error) { stop(error); }
      }
      if (abortSignal?.aborted) onAbort();
    } catch (error) {
      finish(new LauncherError(`Unable to run ${file}: ${error.message}`, 1, { cause: error }));
    }
  });
}

function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
    if (signal.aborted) onAbort();
  });
}

export async function launch({
  root = resolveProjectRoot(), argv = [], version = process.versions.node,
  logger = console, checkPort = assertPortAvailable, locateNpm = findNpmCli,
  spawnImpl = spawn, signalSource = process, stopChild = stopOwnedChild, forceExit = (code) => process.exit(code),
  validateRuntime: checkRuntime = validateRuntime,
} = {}) {
  assertNodeVersion(version);
  const flags = parseFlags(argv);
  if (flags.help) {
    logger.log(HELP);
    return;
  }
  const controller = new AbortController();
  let currentChild;
  const handleSignal = (signal) => {
    if (!controller.signal.aborted) controller.abort(interruption(signal));
    else if (currentChild) {
      try { stopChild(currentChild, 'SIGKILL'); }
      catch (error) { logger.error(`Unable to force-stop owned child: ${error.message}`); }
    } else {
      // A repeated signal must not leave the user trapped in a pending OS operation.
      // Forced termination may leave a lock; its PID/phase rules still protect recovery.
      forceExit(signal === 'SIGINT' ? 130 : 143);
    }
  };
  const onInt = () => handleSignal('SIGINT');
  const onTerm = () => handleSignal('SIGTERM');
  signalSource.on('SIGINT', onInt);
  signalSource.on('SIGTERM', onTerm);
  const checkStopped = () => { if (controller.signal.aborted) throw controller.signal.reason; };
  let lock;
  try {
    // Port preflight must precede any read/write inside installed dependencies.
    await abortable(checkPort(), controller.signal);
    checkStopped();
    const npmCli = await abortable(locateNpm(), controller.signal);
    checkStopped();
    lock = await acquireLock(root, { abortSignal: controller.signal });
    checkStopped();
    // Recheck after acquiring the lock: another application may have started meanwhile.
    await abortable(checkPort(), controller.signal);
    checkStopped();
    let lockText;
    let pkg;
    try {
      lockText = await readFile(path.join(root, 'package-lock.json'), 'utf8');
      pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    } catch (error) {
      throw new LauncherError(`Cannot read project dependency declarations or package-lock.json: ${error.message}. Restore the project files before retrying.`, 1, { cause: error });
    }
    const fingerprint = computeFingerprint(lockText, pkg);
    const childOptions = {
      cwd: root, spawnImpl, signalSource: null, abortSignal: controller.signal, stopChild,
      beforeSpawn: () => lock.beginSpawn(),
      onSpawn: (child) => { currentChild = child; lock.setChild(child.pid); },
    };
    const ensureRuntime = async () => {
      try {
        await checkRuntime(root, childOptions);
      } finally {
        // The real checker resolves/rejects only after its child/group has drained.
        lock.setChild(null);
        currentChild = undefined;
      }
      checkStopped();
    };
    let installRequired = await needsInstall(root, fingerprint);
    if (!installRequired) {
      try { await ensureRuntime(); }
      catch (error) {
        checkStopped();
        logger.log(`The cached dependency runtime is unusable (${error.message}); reinstalling.`);
        installRequired = true;
      }
    }
    if (installRequired) {
      checkStopped();
      await unlink(path.join(root, 'node_modules', MARKER)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      logger.log('Installing project dependencies with npm ci --include=dev --include=optional...');
      const command = npmCommand(npmCli);
      await runChild(command.file, command.args, childOptions);
      lock.setChild(null);
      currentChild = undefined;
      checkStopped();
      if (!await viteInstalled(root, process.platform)) {
        throw new LauncherError('npm ci completed but the local Vite CLI or binary is missing. Check npm configuration (including bin-links), then retry.');
      }
      // Do not certify an installation if declarations changed while npm was running.
      const currentFingerprint = computeFingerprint(await readFile(path.join(root, 'package-lock.json'), 'utf8'),
        JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')));
      if (currentFingerprint !== fingerprint) {
        throw new LauncherError('Dependency declarations changed during installation. Retry after finishing your package edits.');
      }
      await ensureRuntime();
      checkStopped();
      await writeFile(path.join(root, 'node_modules', MARKER), `${fingerprint}\n`, { mode: 0o600 });
    }
    checkStopped();
    // Vite opens the browser only after it has successfully bound its strict port.
    logger.log(`Starting the editor at ${URL} (Ctrl+C to stop).`);
    await runChild(process.execPath, [viteCli(root), '--host', HOST, '--port', String(PORT), '--strictPort',
      ...(flags.open ? ['--open'] : [])], childOptions);
    lock.setChild(null);
    currentChild = undefined;
    checkStopped();
  } finally {
    try { await lock?.release(); }
    finally {
      signalSource.removeListener('SIGINT', onInt);
      signalSource.removeListener('SIGTERM', onTerm);
    }
  }
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedFile === import.meta.url) {
  launch({ argv: process.argv.slice(2) }).catch((error) => {
    console.error(`Local startup failed: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  });
}
