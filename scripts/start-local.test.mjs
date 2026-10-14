import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  assertNodeVersion, parseFlags, resolveProjectRoot, computeFingerprint,
  needsInstall, npmCommand, findNpmCli, assertPortAvailable, acquireLock,
  runChild, launch as launchWithRuntime, validateRuntime,
} from './start-local.mjs';

// Existing launcher scenarios use fake trees; native readiness is isolated below.
const launch = (options) => launchWithRuntime({
  validateRuntime: async () => {},
  ...options,
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'document editor launcher '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { example: '1' } }));
  await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  return root;
}

async function ownerFile(root) {
  const dir = path.join(root, '.start-local.lock');
  const files = (await readdir(dir)).filter((file) => /^owner-.+\.json$/.test(file));
  assert.equal(files.length, 1, 'expected exactly one token-specific owner file');
  return path.join(dir, files[0]);
}

async function fakeVite(root) {
  await mkdir(path.join(root, 'node_modules', 'vite', 'bin'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '');
  await writeFile(path.join(root, 'node_modules', '.bin', 'vite'), '');
  await writeFile(path.join(root, 'node_modules', '.bin', 'vite.cmd'), '');
}

function fakeChild(action) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  queueMicrotask(() => Promise.resolve().then(() => action(child)).catch((error) => {
    child.exitCode = 1;
    child.emit('error', error);
    child.emit('close', 1, null);
  }));
  return child;
}

const quiet = { log() {}, error() {} };

// These boundaries catch allowing unsupported Node releases or rejecting supported releases.
test('Node minimum is 22.12, with newer majors accepted', () => {
  for (const version of ['18.20.0', '22.11.9', '21.99.0', 'invalid', '22.12.0-rc.1']) {
    assert.throws(() => assertNodeVersion(version), /22\.12.*LTS/);
  }
  for (const version of ['22.12.0', '22.13.1', '24.0.0', '26.1.0']) {
    assert.doesNotThrow(() => assertNodeVersion(version));
  }
});

test('flags default to opening the browser and reject host/port and positional arguments', () => {
  assert.deepEqual(parseFlags([]), { help: false, open: true });
  assert.deepEqual(parseFlags(['--no-open']), { help: false, open: false });
  assert.deepEqual(parseFlags(['--help', '--no-open']), { help: true, open: false });
  for (const flag of ['--host', '--port=8080', '8080', '--', '-x']) {
    assert.throws(() => parseFlags([flag]), /Unknown argument/);
  }
});

test('root derives from a module URL with spaces, never from invoking cwd', async (t) => {
  const root = await fixture(t);
  assert.equal(resolveProjectRoot(pathToFileURL(path.join(root, 'scripts', 'start-local.mjs'))), root);
  assert.notEqual(root, process.cwd());
});

test('fingerprint changes with lock/dependency declarations but not ordinary start scripts', () => {
  const base = { dependencies: { a: '1' }, devDependencies: { vite: '6' }, scripts: { start: 'old' } };
  const hash = computeFingerprint('lock one', base);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(computeFingerprint('lock one', { ...base, scripts: { start: 'new' } }), hash);
  assert.notEqual(computeFingerprint('lock two', base), hash);
  assert.notEqual(computeFingerprint('lock one', { ...base, dependencies: { a: '2' } }), hash);
  assert.notEqual(computeFingerprint('lock one', { ...base, devDependencies: { vite: '7' } }), hash);
  assert.notEqual(computeFingerprint('lock one', { ...base, overrides: { a: '3' } }), hash);
  assert.equal(computeFingerprint('lock one', { dependencies: { b: '2', a: '1' } }),
    computeFingerprint('lock one', { dependencies: { a: '1', b: '2' } }));
});

test('first launch, changed fingerprint, or missing Vite shim/CLI requires installation', async (t) => {
  const root = await fixture(t);
  assert.equal(await needsInstall(root, 'abc'), true);
  await fakeVite(root);
  await writeFile(path.join(root, 'node_modules', '.start-local-fingerprint'), 'abc\n');
  assert.equal(await needsInstall(root, 'abc'), false);
  assert.equal(await needsInstall(root, 'different'), true);
  await rm(path.join(root, 'node_modules', '.bin', 'vite.cmd'));
  assert.equal(await needsInstall(root, 'abc', 'win32'), true);
  await rm(path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'));
  assert.equal(await needsInstall(root, 'abc'), true);
});

test('Windows npm construction uses Node CLI arguments without cmd interpolation', () => {
  const cli = 'C:\\Program Files\\node & tools\\node_modules\\npm\\bin\\npm-cli.js';
  const command = npmCommand(cli, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(command, {
    file: 'C:\\Program Files\\nodejs\\node.exe',
    args: [cli, 'ci', '--include=dev', '--include=optional'],
  });
  assert.throws(() => npmCommand('C:\\nodejs\\npm.cmd'), /npm-cli\.js/);
});

test('npm discovery works beside a Windows npm.cmd without executing it', async (t) => {
  const root = await fixture(t);
  const cli = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, '');
  await writeFile(path.join(root, 'npm.cmd'), 'not executable');
  assert.equal(await findNpmCli({ execPath: path.join(root, 'node.exe'), env: {}, platform: 'win32' }), cli);
});

test('missing npm gives a clear prerequisite error', async (t) => {
  const root = await fixture(t);
  await assert.rejects(findNpmCli({ execPath: path.join(root, 'missing', 'node'), env: {}, platform: 'linux' }), /npm.*Node.*LTS/i);
});

test('occupied-port error gives instructions without fallback or dependency access', async () => {
  const addresses = [];
  const probe = new EventEmitter();
  probe.listen = (address) => {
    addresses.push(address);
    queueMicrotask(() => probe.emit('error', Object.assign(new Error('occupied'), { code: 'EADDRINUSE' })));
  };
  probe.close = () => { throw new Error('must not close a different server'); };
  await assert.rejects(assertPortAvailable({ createServer: () => probe }), /already in use.*stop.*5173/is);
  assert.deepEqual(addresses, [{ host: '127.0.0.1', port: 5173, exclusive: true }]);
});
test('active launcher lock is preserved and own lock is cleaned', async (t) => {
  const root = await fixture(t);
  const lock = await acquireLock(root);
  await assert.rejects(acquireLock(root), /another launcher|active/i);
  const file = await ownerFile(root);
  const owner = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(path.basename(file), `owner-${owner.token}.json`);
  assert.equal(owner.pid, process.pid);
  await lock.release();
  await assert.rejects(access(path.join(root, '.start-local.lock')), { code: 'ENOENT' });
});

test('dead pid is recovered but a living recorded child prevents recovery', async (t) => {
  const root = await fixture(t);
  const dir = path.join(root, '.start-local.lock');
  await mkdir(dir);
  await writeFile(path.join(dir, 'owner-stale.json'), JSON.stringify({ pid: 44444, childPid: 55555, token: 'stale', hostname: hostname() }));
  await assert.rejects(acquireLock(root, { isAlive: (pid) => pid === 55555 }), /active/i);
  const lock = await acquireLock(root, { isAlive: () => false });
  const file = await ownerFile(root);
  const owner = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.equal(path.basename(file), `owner-${owner.token}.json`);
  await assert.rejects(access(path.join(dir, 'owner-stale.json')), { code: 'ENOENT' });
  await lock.release();
});

test('malformed or foreign-host locks are not blindly removed', async (t) => {
  const root = await fixture(t);
  const dir = path.join(root, '.start-local.lock');
  await mkdir(dir);
  const brokenFile = path.join(dir, 'owner-broken.json');
  await writeFile(brokenFile, 'broken');
  await assert.rejects(acquireLock(root), /verify|inspect/i);
  assert.equal(await readFile(brokenFile, 'utf8'), 'broken');
  await rm(brokenFile);
  const foreignFile = path.join(dir, 'owner-foreign.json');
  const foreignOwner = JSON.stringify({ pid: 44444, token: 'foreign', hostname: 'another-computer' });
  await writeFile(foreignFile, foreignOwner);
  await assert.rejects(acquireLock(root, { isAlive: () => false }), /verify|inspect/i);
  assert.equal(await readFile(foreignFile, 'utf8'), foreignOwner);
});

test('release never deletes a replacement owner lock', async (t) => {
  const root = await fixture(t);
  const lock = await acquireLock(root);
  const file = await ownerFile(root);
  const owner = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...owner, token: 'replacement' }));
  await lock.release();
  assert.equal(JSON.parse(await readFile(file, 'utf8')).token, 'replacement');
});

test('simultaneous launchers grant exactly one lock', async (t) => {
  const root = await fixture(t);
  const results = await Promise.allSettled([acquireLock(root), acquireLock(root)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  await results.find((result) => result.status === 'fulfilled').value.release();
});

test('spawn-in-progress lock refuses dead-pid recovery and preserves manual recovery instructions', async (t) => {
  const root = await fixture(t);
  const lock = await acquireLock(root);
  lock.beginSpawn();
  const file = await ownerFile(root);
  const owner = JSON.parse(await readFile(file, 'utf8'));
  const interruptedOwner = JSON.stringify({ ...owner, pid: 44444 });
  await writeFile(file, interruptedOwner);
  await assert.rejects(acquireLock(root, { isAlive: () => false }), (error) => {
    assert.match(error.message, /Cannot safely recover launcher lock/i);
    assert.ok(error.message.includes(path.join(root, '.start-local.lock')));
    assert.match(error.message, /inspect.*verify.*before manually removing/i);
    assert.match(error.message, /Do not remove an active lock/i);
    return true;
  });
  assert.equal(await ownerFile(root), file);
  assert.equal(await readFile(file, 'utf8'), interruptedOwner);
});

test('simultaneous stale recoverers never grant two locks', async (t) => {
  const root = await fixture(t);
  const dir = path.join(root, '.start-local.lock');
  await mkdir(dir);
  await writeFile(path.join(dir, 'owner-stale.json'),
    JSON.stringify({ pid: 44444, childPid: null, token: 'stale', hostname: hostname() }));
  const options = { isAlive: (pid) => pid === process.pid };
  const results = await Promise.allSettled([acquireLock(root, options), acquireLock(root, options)]);
  const acquired = results.filter((result) => result.status === 'fulfilled');
  try {
    assert.ok(acquired.length <= 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 2 - acquired.length);
    if (acquired.length === 1) {
      const file = await ownerFile(root);
      const owner = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(owner.pid, process.pid);
      assert.notEqual(owner.token, 'stale');
      assert.equal(path.basename(file), `owner-${owner.token}.json`);
    }
  } finally {
    await Promise.all(acquired.map((result) => result.value.release()));
  }
  if (acquired.length === 1) await assert.rejects(access(dir), { code: 'ENOENT' });
  else await access(dir); // Ambiguous competing recovery fails closed for manual inspection.
});

test('child nonzero exit, asynchronous spawn error, and thrown spawn error propagate', async () => {
  await assert.rejects(runChild('node', [], {
    stopChild: (child, signal) => child.kill(signal),
    spawnImpl: () => fakeChild((child) => child.emit('close', 7, null)),
  }), (error) => error.exitCode === 7);
  await assert.rejects(runChild('node', [], {
    stopChild: (child, signal) => child.kill(signal),
    spawnImpl: () => fakeChild((child) => child.emit('error', new Error('spawn ENOENT'))),
  }), /spawn ENOENT/);
  await assert.rejects(runChild('node', [], { spawnImpl: () => { throw new Error('spawn EACCES'); } }), /spawn EACCES/);
});

test('child success waits for close and removes signal listeners', async () => {
  const signals = new EventEmitter();
  await runChild('node', [], { signalSource: signals,
    stopChild: (child, signal) => child.kill(signal),
    spawnImpl: () => fakeChild((child) => child.emit('close', 0, null)),
  });
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal} stops only the owned child and reports interruption`, async () => {
    const signals = new EventEmitter();
    const killed = [];
    await assert.rejects(runChild('node', [], { signalSource: signals,
      spawnImpl: () => fakeChild(() => signals.emit(signal)),
      stopChild: (child, value) => { killed.push([child.pid, value]); child.kill(value); },
    }), (error) => error.exitCode === exitCode);
    assert.deepEqual(killed, [[12345, 'SIGTERM']]);
    assert.equal(signals.listenerCount(signal), 0);
  });
}

test('help is side-effect free even with missing project files/npm', async (t) => {
  const root = await fixture(t);
  await rm(path.join(root, 'package-lock.json'));
  const messages = [];
  await launch({ root, argv: ['--help'], logger: { log: (message) => messages.push(message) },
    checkPort: () => { throw new Error('must not check'); },
    locateNpm: () => { throw new Error('must not discover npm'); },
  });
  assert.match(messages.join('\n'), /--no-open/);
  await assert.rejects(access(path.join(root, '.start-local.lock')), { code: 'ENOENT' });
});

test('occupied port fails before install state is touched', async (t) => {
  const root = await fixture(t);
  const sentinel = path.join(root, 'node_modules', 'sentinel');
  await mkdir(path.dirname(sentinel));
  await writeFile(sentinel, 'keep');
  await assert.rejects(launch({ root, logger: quiet,
    checkPort: () => { throw new Error('port already in use'); },
    locateNpm: () => { throw new Error('npm discovery must not run'); },
    spawnImpl: () => { throw new Error('spawn must not run'); },
  }), /port already in use/);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  await assert.rejects(access(path.join(root, '.start-local.lock')), { code: 'ENOENT' });
});

test('install failure leaves no marker, no Vite process, and no lock', async (t) => {
  const root = await fixture(t);
  const invocations = [];
  await assert.rejects(launch({ root, logger: quiet, checkPort: async () => {},
    locateNpm: async () => '/fake/npm-cli.js',
    stopChild: (child, signal) => child.kill(signal),
    spawnImpl: (file, args, options) => {
      invocations.push({ file, args, options });
      return fakeChild((child) => child.emit('close', 8, null));
    },
  }), (error) => error.exitCode === 8);
  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0].args, ['/fake/npm-cli.js', 'ci', '--include=dev', '--include=optional']);
  assert.equal(invocations[0].options.cwd, root);
  assert.equal(invocations[0].options.shell, false);
  await assert.rejects(access(path.join(root, 'node_modules', '.start-local-fingerprint')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(root, '.start-local.lock')), { code: 'ENOENT' });
});

for (const open of [true, false]) {
  test(`successful install precedes marker and fixed-loopback Vite (open=${open})`, async (t) => {
    const root = await fixture(t);
    const invocations = [];
    await launch({ root, argv: open ? [] : ['--no-open'], logger: quiet,
      checkPort: async () => {}, locateNpm: async () => '/fake/npm-cli.js',
      stopChild: (child, signal) => child.kill(signal),
      spawnImpl: (file, args, options) => {
        invocations.push({ file, args, options });
        if (invocations.length === 1) {
          return fakeChild(async (child) => { await fakeVite(root); child.emit('close', 0, null); });
        }
        return fakeChild(async (child) => {
          assert.match(await readFile(path.join(root, 'node_modules', '.start-local-fingerprint'), 'utf8'), /^[a-f0-9]{64}\n$/);
          child.emit('close', 0, null);
        });
      },
    });
    assert.equal(invocations.length, 2);
    assert.equal(invocations[1].file, process.execPath);
    assert.deepEqual(invocations[1].args, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--host', '127.0.0.1', '--port', '5173', '--strictPort', ...(open ? ['--open'] : [])]);
    assert.equal(invocations[1].options.cwd, root);
    assert.equal(invocations[1].options.shell, false);
    await assert.rejects(access(path.join(root, '.start-local.lock')), { code: 'ENOENT' });
  });
}

test('matching marker skips npm ci and server failure remains a failure', async (t) => {
  const root = await fixture(t);
  await fakeVite(root);
  const fingerprint = computeFingerprint(await readFile(path.join(root, 'package-lock.json'), 'utf8'),
    JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')));
  await writeFile(path.join(root, 'node_modules', '.start-local-fingerprint'), `${fingerprint}\n`);
  const calls = [];
  await assert.rejects(launch({ root, argv: ['--no-open'], logger: quiet,
    checkPort: async () => {}, locateNpm: async () => '/fake/npm-cli.js',
    stopChild: (child, signal) => child.kill(signal),
    spawnImpl: (file, args) => { calls.push(args); return fakeChild((child) => child.emit('close', 9, null)); },
  }), (error) => error.exitCode === 9);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /vite[\\/]bin[\\/]vite\.js$/);
  await assert.rejects(access(path.join(root, '.start-local.lock')), { code: 'ENOENT' });
});

test('default launcher root remains correct when copied to a spaced path outside cwd', async (t) => {
  const root = await fixture(t);
  const script = path.join(root, 'scripts', 'start-local.mjs');
  await mkdir(path.dirname(script));
  await writeFile(script, await readFile(new URL('./start-local.mjs', import.meta.url)));
  const copied = await import(pathToFileURL(script).href);
  const directories = [];
  await copied.launch({ argv: ['--no-open'], logger: quiet,
    checkPort: async () => {}, locateNpm: async () => '/fake/npm-cli.js',
    stopChild: (child, signal) => child.kill(signal),
    validateRuntime: async () => {},
    spawnImpl: (file, args, options) => {
      directories.push(options.cwd);
      return fakeChild(async (child) => {
        if (directories.length === 1) await fakeVite(root);
        child.emit('close', 0, null);
      });
    },
  });
  const canonicalRoot = await realpath(root);
  assert.deepEqual(directories, [canonicalRoot, canonicalRoot]);
  assert.notEqual(root, process.cwd());
});

test('successful npm exit without Vite never certifies the install or starts a server', async (t) => {
  const root = await fixture(t);
  let calls = 0;
  await assert.rejects(launch({ root, logger: quiet, checkPort: async () => {},
    locateNpm: async () => '/fake/npm-cli.js',
    stopChild: (child, signal) => child.kill(signal),
    spawnImpl: () => { calls++; return fakeChild((child) => child.emit('close', 0, null)); },
  }), /Vite.*missing/);
  assert.equal(calls, 1);
  await assert.rejects(access(path.join(root, 'node_modules', '.start-local-fingerprint')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(root, '.start-local.lock')), { code: 'ENOENT' });
});

test('declarations edited during npm ci prevent marker creation and server startup', async (t) => {
  const root = await fixture(t);
  let calls = 0;
  await assert.rejects(launch({ root, logger: quiet, checkPort: async () => {},
    locateNpm: async () => '/fake/npm-cli.js',
    stopChild: (child, signal) => child.kill(signal),
    spawnImpl: () => {
      calls++;
      return fakeChild(async (child) => {
        await fakeVite(root);
        await writeFile(path.join(root, 'package-lock.json'), 'changed lock');
        child.emit('close', 0, null);
      });
    },
  }), /changed during installation/);
  assert.equal(calls, 1);
  await assert.rejects(access(path.join(root, 'node_modules', '.start-local-fingerprint')), { code: 'ENOENT' });
});

test('npm spawn failure cleans the owned lock and preserves the spawn error', async (t) => {
  const root = await fixture(t);
  await assert.rejects(launch({ root, logger: quiet, checkPort: async () => {},
    locateNpm: async () => '/fake/npm-cli.js',
    spawnImpl: () => { throw new Error('spawn EACCES'); },
  }), /spawn EACCES/);
  await assert.rejects(access(path.join(root, '.start-local.lock')), { code: 'ENOENT' });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  for (const phase of ['install', 'server']) {
    test(`${signal} during ${phase} cleans the lock without touching stored data`, async (t) => {
      const root = await fixture(t);
      const data = path.join(root, 'user-data-sentinel');
      await writeFile(data, 'do not touch');
      const signals = new EventEmitter();
      const killed = [];
      let calls = 0;
      await assert.rejects(launch({ root, logger: quiet, signalSource: signals,
        checkPort: async () => {}, locateNpm: async () => '/fake/npm-cli.js',
        stopChild: (child, value) => { killed.push([child.pid, value]); child.kill(value); },
        spawnImpl: () => {
          calls++;
          const current = calls;
          return fakeChild(async (child) => {
            if (phase === 'install' || current === 2) signals.emit(signal);
            else { await fakeVite(root); child.emit('close', 0, null); }
          });
        },
      }), (error) => error.exitCode === (signal === 'SIGINT' ? 130 : 143));
      assert.deepEqual(killed, [[12345, 'SIGTERM']]);
      assert.equal(calls, phase === 'install' ? 1 : 2);
      assert.equal(await readFile(data, 'utf8'), 'do not touch');
      assert.equal(signals.listenerCount('SIGINT'), 0);
      assert.equal(signals.listenerCount('SIGTERM'), 0);
      await assert.rejects(access(path.join(root, '.start-local.lock')), { code: 'ENOENT' });
      if (phase === 'install') {
        await assert.rejects(access(path.join(root, 'node_modules', '.start-local-fingerprint')), { code: 'ENOENT' });
      }
    });
  }
}

test('signal received between preflight and child spawn prevents all installation work', async (t) => {
  const root = await fixture(t);
  const signals = new EventEmitter();
  await assert.rejects(launch({ root, logger: quiet, signalSource: signals,
    checkPort: async () => { signals.emit('SIGINT'); },
    locateNpm: () => { throw new Error('must not discover npm'); },
    spawnImpl: () => { throw new Error('must not spawn'); },
  }), (error) => error.exitCode === 130);
  await assert.rejects(access(path.join(root, '.start-local.lock')), { code: 'ENOENT' });
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('repeated child errors remain handled while shutdown waits for close', async () => {
  await assert.rejects(runChild('node', [], {
    stopChild: (child, signal) => {
      child.emit('error', new Error('secondary kill error'));
      child.kill(signal);
    },
    spawnImpl: () => fakeChild((child) => child.emit('error', new Error('initial child error'))),
  }), /initial child error/);
});

test('release removes only its token file and preserves a different owner file', async (t) => {
  const root = await fixture(t);
  const lock = await acquireLock(root);
  const own = await ownerFile(root);
  const replacement = path.join(root, '.start-local.lock', 'owner-replacement.json');
  const contents = JSON.stringify({ pid: process.pid, token: 'replacement', hostname: hostname() });
  await writeFile(replacement, contents);
  await assert.rejects(lock.release(), /Cannot safely recover/);
  assert.equal(await readFile(replacement, 'utf8'), contents);
  await assert.rejects(access(own), { code: 'ENOENT' });
});

test('a pending preflight can be interrupted without waiting for its result', async (t) => {
  const root = await fixture(t);
  const signals = new EventEmitter();
  const pending = launch({ root, logger: quiet, signalSource: signals,
    checkPort: () => new Promise(() => {}),
    locateNpm: () => { throw new Error('must not discover npm'); },
  });
  signals.emit('SIGTERM');
  await assert.rejects(pending, (error) => error.exitCode === 143);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  await assert.rejects(access(path.join(root, '.start-local.lock')), { code: 'ENOENT' });
});

test('a repeated signal escalates shutdown only for the owned child', async (t) => {
  const root = await fixture(t);
  const signals = new EventEmitter();
  const killed = [];
  await assert.rejects(launch({ root, logger: quiet, signalSource: signals,
    checkPort: async () => {}, locateNpm: async () => '/fake/npm-cli.js',
    forceExit: () => { throw new Error('must not exit with an owned child'); },
    stopChild: (child, signal) => { killed.push([child.pid, signal]); child.kill(signal); },
    spawnImpl: () => fakeChild(() => { signals.emit('SIGINT'); signals.emit('SIGINT'); }),
  }), (error) => error.exitCode === 130);
  assert.deepEqual(killed, [[12345, 'SIGTERM'], [12345, 'SIGKILL']]);
  await assert.rejects(access(path.join(root, '.start-local.lock')), { code: 'ENOENT' });
});

test('unknown lock directory contents preserve the stale owner for inspection', async (t) => {
  const root = await fixture(t);
  const dir = path.join(root, '.start-local.lock');
  await mkdir(dir);
  const file = path.join(dir, 'owner-stale.json');
  const contents = JSON.stringify({ pid: 44444, token: 'stale', hostname: hostname() });
  await writeFile(file, contents);
  await writeFile(path.join(dir, 'unexpected-file'), 'inspect me');
  await assert.rejects(acquireLock(root, { isAlive: () => false }), /Cannot safely recover/);
  assert.equal(await readFile(file, 'utf8'), contents);
  assert.equal(await readFile(path.join(dir, 'unexpected-file'), 'utf8'), 'inspect me');
});

test('all seven npm ci lifecycle hooks invalidate the installation fingerprint', () => {
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
    const original = computeFingerprint('same lock', { scripts: { [hook]: 'old' } });
    assert.notEqual(computeFingerprint('same lock', { scripts: { [hook]: 'new' } }), original, hook);
    assert.notEqual(computeFingerprint('same lock', {}), original, hook);
  }
});

test('failed native readiness never certifies an otherwise present Vite install', async (t) => {
  const root = await fixture(t);
  let invocations = 0;
  let checked = 0;
  await assert.rejects(launch({ root, logger: quiet,
    checkPort: async () => {}, locateNpm: async () => '/fake/npm-cli.js',
    stopChild: (child, signal) => child.kill(signal),
    validateRuntime: async () => {
      checked++;
      await assert.rejects(access(path.join(root, 'node_modules', '.start-local-fingerprint')), { code: 'ENOENT' });
      throw new Error('Rollup native optional dependency is unusable');
    },
    spawnImpl: () => {
      invocations++;
      return fakeChild(async (child) => { await fakeVite(root); child.emit('close', 0, null); });
    },
  }), /native optional dependency is unusable/);
  assert.equal(checked, 1);
  assert.equal(invocations, 1);
  await assert.rejects(access(path.join(root, 'node_modules', '.start-local-fingerprint')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(root, '.start-local.lock')), { code: 'ENOENT' });
});

test('an unusable cached native tree is reinstalled and recertified before server startup', async (t) => {
  const root = await fixture(t);
  await fakeVite(root);
  const fingerprint = computeFingerprint(await readFile(path.join(root, 'package-lock.json'), 'utf8'),
    JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')));
  const marker = path.join(root, 'node_modules', '.start-local-fingerprint');
  await writeFile(marker, `${fingerprint}\n`);
  const events = [];
  let checked = 0;
  await launch({ root, logger: quiet, checkPort: async () => {}, locateNpm: async () => '/fake/npm-cli.js',
    stopChild: (child, signal) => child.kill(signal),
    validateRuntime: async () => {
      events.push('check');
      if (++checked === 1) throw new Error('esbuild executable is unusable');
      await assert.rejects(access(marker), { code: 'ENOENT' });
    },
    spawnImpl: (file, args) => fakeChild(async (child) => {
      if (args[1] === 'ci') {
        events.push('install');
        await assert.rejects(access(marker), { code: 'ENOENT' });
      } else {
        events.push('server');
        assert.equal(await readFile(marker, 'utf8'), `${fingerprint}\n`);
      }
      child.emit('close', 0, null);
    }),
  });
  assert.deepEqual(events, ['check', 'install', 'check', 'server']);
});

test('POSIX shutdown keeps the lock and escalation after the group leader closes', async (t) => {
  const root = await fixture(t);
  const lock = await acquireLock(root);
  const signals = new EventEmitter();
  let groupLives = true;
  let leader;
  let acknowledgeClose;
  const closed = new Promise((resolve) => { acknowledgeClose = resolve; });
  const killed = [];
  const probed = [];
  let settled = false;
  const pending = runChild('fake-node', [], {
    platform: 'linux', signalSource: signals, shutdownGraceMs: 15, groupPollMs: 1,
    beforeSpawn: () => lock.beginSpawn(), onSpawn: (child) => lock.setChild(child.pid),
    spawnImpl: () => {
      leader = new EventEmitter();
      leader.pid = 24680;
      leader.exitCode = null;
      leader.signalCode = null;
      return leader;
    },
    probeGroup: (groupId) => { probed.push(groupId); return groupLives; },
    stopChild: (child, signal) => {
      killed.push([child.pid, signal]);
      if (signal === 'SIGTERM') {
        child.exitCode = 143;
        child.emit('close', 143, null);
        acknowledgeClose();
      } else {
        assert.equal(child.exitCode, 143, 'leader has already closed');
        groupLives = false;
      }
    },
  }).finally(() => lock.release());
  pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, (error) => error.exitCode === 143);
  signals.emit('SIGTERM');
  await closed;
  assert.equal(settled, false);
  await access(path.join(root, '.start-local.lock'));
  await assert.rejects(acquireLock(root), /active/i);
  await rejected;
  assert.deepEqual(killed, [[24680, 'SIGTERM'], [24680, 'SIGKILL']]);
  assert.ok(probed.length > 1);
  assert.ok(probed.every((groupId) => groupId === 24680));
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  await assert.rejects(access(path.join(root, '.start-local.lock')), { code: 'ENOENT' });
});

test('a terminated owned group is never signalled again after cleanup', async () => {
  const signals = new EventEmitter();
  const killed = [];
  await assert.rejects(runChild('fake-node', [], {
    platform: 'linux', signalSource: signals, probeGroup: () => false,
    spawnImpl: () => fakeChild(() => signals.emit('SIGINT')),
    stopChild: (child, signal) => { killed.push([child.pid, signal]); child.kill(signal); },
  }), (error) => error.exitCode === 130);
  signals.emit('SIGINT');
  assert.deepEqual(killed, [[12345, 'SIGTERM']]);
});

async function fakeRuntimeTree(root, broken) {
  await fakeVite(root);
  const vite = path.join(root, 'node_modules', 'vite');
  await mkdir(path.join(vite, 'dist', 'node'), { recursive: true });
  await writeFile(path.join(vite, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(vite, 'dist', 'node', 'index.js'), broken === 'vite'
    ? "throw new Error('Vite runtime is unusable');"
    : "import { appendFileSync } from 'node:fs'; appendFileSync('readiness-events', 'vite\\n'); export function createServer() {}");
  const rollup = path.join(root, 'node_modules', 'rollup');
  await mkdir(rollup);
  await writeFile(path.join(rollup, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  await writeFile(path.join(rollup, 'index.cjs'), `
    const log = (event) => require('node:fs').appendFileSync('readiness-events', event + '\\n');
    log('rollup-load');
    exports.rollup = async () => {
      log('rollup');
      ${broken === 'rollup' ? "throw new Error('Rollup optional native binding is unusable');" : ''}
      return {
        generate: async () => { log('generate'); return { output: [{ type: 'chunk', code: 'export const launcherReady = true;' }] }; },
        close: async () => log('close'),
      };
    };
  `);
  const esbuild = path.join(root, 'node_modules', 'esbuild');
  await mkdir(esbuild);
  await writeFile(path.join(esbuild, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  await writeFile(path.join(esbuild, 'index.cjs'), `
    const log = (event) => require('node:fs').appendFileSync('readiness-events', event + '\\n');
    log('esbuild-load');
    exports.transform = async () => {
      log('transform');
      ${broken === 'esbuild' ? "throw new Error('esbuild platform executable is unusable');" : ''}
      return { code: 'export const launcherReady = true;' };
    };
    exports.stop = () => log('stop');
  `);
}

// These children execute only temporary fake module interfaces, never npm or a real build.
const quietRuntimeChild = (file, args, options) => spawn(file, args, { ...options, stdio: 'ignore' });

test('readiness executes Vite loading, Rollup generation/close, and esbuild transformation/stop', async (t) => {
  const root = await fixture(t);
  await fakeRuntimeTree(root);
  await validateRuntime(root, { spawnImpl: quietRuntimeChild });
  assert.deepEqual((await readFile(path.join(root, 'readiness-events'), 'utf8')).trim().split('\n'),
    ['vite', 'rollup-load', 'rollup', 'generate', 'close', 'esbuild-load', 'transform', 'stop']);
});

for (const broken of ['vite', 'rollup', 'esbuild']) {
  test(`readiness detects an unusable ${broken} runtime despite CLI files existing`, async (t) => {
    const root = await fixture(t);
    await fakeRuntimeTree(root, broken);
    await assert.rejects(validateRuntime(root, { spawnImpl: quietRuntimeChild }),
      (error) => /runtime readiness failed/.test(error.message) && error.exitCode === 1);
  });
}

test('the old fingerprint schema marker cannot skip the new optional/native installation policy', async (t) => {
  const root = await fixture(t);
  await fakeVite(root);
  const lockText = await readFile(path.join(root, 'package-lock.json'), 'utf8');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const legacy = createHash('sha256').update(JSON.stringify({
    schema: 1, lockText, declarations: { dependencies: { example: '1' }, installScripts: {} },
    platform: process.platform, arch: process.arch, nodeMajor: process.versions.node.split('.')[0],
  })).digest('hex');
  await writeFile(path.join(root, 'node_modules', '.start-local-fingerprint'), `${legacy}\n`);
  assert.equal(await needsInstall(root, computeFingerprint(lockText, pkg)), true);
});

test('stale recovery preserves an owned group even when its leader and launcher are dead', async (t) => {
  const root = await fixture(t);
  const dir = path.join(root, '.start-local.lock');
  await mkdir(dir);
  const file = path.join(dir, 'owner-stale.json');
  const contents = JSON.stringify({
    pid: 44444, childPid: 55555, childGroupId: 55555, phase: 'running', token: 'stale', hostname: hostname(),
  });
  await writeFile(file, contents);
  await assert.rejects(acquireLock(root, {
    isAlive: () => false, isGroupAlive: (groupId) => groupId === 55555,
  }), /active/i);
  assert.equal(await readFile(file, 'utf8'), contents);
});

test('a failed POSIX leader exit drains remaining descendants before propagating its code', async () => {
  let groupLives = true;
  const killed = [];
  await assert.rejects(runChild('fake-node', [], {
    platform: 'linux', shutdownGraceMs: 10, groupPollMs: 1,
    probeGroup: (groupId) => { assert.equal(groupId, 12345); return groupLives; },
    spawnImpl: () => fakeChild((child) => {
      child.exitCode = 9;
      child.emit('close', 9, null);
    }),
    stopChild: (child, signal) => {
      assert.equal(child.exitCode, 9);
      killed.push(signal);
      if (signal === 'SIGKILL') groupLives = false;
    },
  }), (error) => error.exitCode === 9);
  assert.deepEqual(killed, ['SIGTERM', 'SIGKILL']);
});
