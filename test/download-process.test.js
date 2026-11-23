'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { downloadSpawnOptions, terminateProcessTree } = require('../src/download-process');

test('download roots are detached from the utility and never open a console', () => {
  assert.deepEqual(downloadSpawnOptions(), { windowsHide: true, shell: false, detached: true });
});

test('Windows termination targets the created PID and waits for tree killer', async () => {
  const killer = new EventEmitter();
  let command;
  let args;
  let options;
  const child = { pid: 4321, kill() { throw new Error('direct kill should not run'); } };
  let finished = false;
  const promise = terminateProcessTree(child, {
    platform: 'win32',
    spawnProcess: (cmd, values, opts) => {
      command = cmd; args = values; options = opts; return killer;
    },
  }).then((result) => { finished = true; return result; });
  assert.equal(command, 'taskkill.exe');
  assert.deepEqual(args, ['/PID', '4321', '/T', '/F']);
  assert.equal(options.shell, false);
  assert.equal(finished, false);
  killer.emit('close', 0);
  assert.equal(await promise, true);
});

test('failed tree killer falls back to the direct child', async () => {
  const killer = new EventEmitter();
  let killed = 0;
  const child = { pid: 4321, kill() { killed++; } };
  const promise = terminateProcessTree(child, {
    platform: 'win32', spawnProcess: () => killer,
  });
  killer.emit('error', new Error('unavailable'));
  assert.equal(await promise, false);
  assert.equal(killed, 1);
});

test('hung tree killer times out, stops helper, and falls back to direct child', async () => {
  const killer = new EventEmitter();
  let helperKills = 0;
  let childKills = 0;
  killer.kill = () => { helperKills++; };
  const result = await terminateProcessTree({ pid: 4321, kill() { childKills++; } }, {
    platform: 'win32', spawnProcess: () => killer, timeoutMs: 10,
  });
  assert.equal(result, false);
  assert.equal(helperKills, 1);
  assert.equal(childKills, 1);
  killer.emit('close', 0);
  assert.equal(childKills, 1);
});

test('Windows tree termination also stops a spawned grandchild', { skip: process.platform !== 'win32' }, async (t) => {
  const script = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "process.stdout.write(String(child.pid) + '\\n');",
    'setInterval(() => {}, 1000);',
  ].join(' ');
  const parent = spawn(process.execPath, ['-e', script], {
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let grandchildPid;
  const errors = [];
  try {
    grandchildPid = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('No grandchild PID')), 5000);
      parent.stdout.on('data', (chunk) => {
        output += chunk.toString();
        const line = output.split(/\r?\n/)[0];
        if (/^\d+$/.test(line)) {
          clearTimeout(timeout);
          resolve(Number(line));
        }
      });
      parent.once('error', reject);
    });
    const closed = once(parent, 'close');
    const terminated = await terminateProcessTree(parent, {
      platform: 'win32',
      spawnProcess: (cmd, args, options) => {
        const killer = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
        killer.stderr.on('data', (chunk) => errors.push(chunk));
        return killer;
      },
    });
    const errorText = new TextDecoder('gbk').decode(Buffer.concat(errors));
    if (!terminated && /拒绝访问|Access is denied/i.test(errorText)) {
      t.skip('Windows taskkill is denied by the current sandbox');
      return;
    }
    assert.equal(terminated, true, errorText);
    await closed;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { process.kill(grandchildPid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('Grandchild remained alive after taskkill /T /F');
  } finally {
    try { process.kill(parent.pid); } catch { /* Already stopped. */ }
    if (grandchildPid) {
      try { process.kill(grandchildPid); } catch { /* Already stopped. */ }
    }
  }
});
