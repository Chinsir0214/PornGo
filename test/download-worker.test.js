'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { observeTaskkill } = require('./taskkill-fixture');
const { terminateProcessTree } = require('../src/download-process');
const { createDownloadWorker } = require('../src/download-worker-client');

// Node's IPC channel transports the same messages as Electron's utility process.
function launchTestWorker() {
  const entry = require.resolve('../src/download-worker');
  const script = `require(${JSON.stringify(entry)}).serveDownloads({
    on: (event, fn) => process.on(event, data => fn({data})),
    postMessage: message => process.send(message)
  })`;
  const child = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.postMessage = (message) => child.send(message);
  return child;
}

function toolParams(script) {
  return { binary: process.execPath, baseArgs: ['-e', script, '--'], video: { url: 'local.test' },
    url: 'local.test', fragmentConcurrency: 1 };
}

test('on-demand worker shares concurrent jobs, filters large metadata and coalesces progress before completion', async (t) => {
  let launches = 0;
  const worker = createDownloadWorker(() => { launches++; return launchTestWorker(); });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'porngo-worker-'));
  t.after(async () => { await worker.close(); await fs.rm(directory, { recursive: true, force: true }); });
  assert.equal(launches, 0);
  const file = path.join(directory, '标题.mp4');
  await fs.writeFile(file, '');
  const metadataScript = "process.stdout.write(JSON.stringify({id:'a',title:'A',formats:[{height:720}],description:'x'.repeat(1048576)}))";
  const record = JSON.stringify({ filepath: file, upload_date: '20221104' });
  const script = `process.stdout.write('[download] 1% at 2MiB/s ETA 00:10\\n'.repeat(3000)
    + '[download] 99% at 8MiB/s ETA 00:01\\n' + ${JSON.stringify('PORNGO_FILE:' + record)})`;
  const progress = [];
  const [info, downloaded] = await Promise.all([
    worker.request('metadata', toolParams(metadataScript)),
    worker.request('download', { ...toolParams(script), directory },
      { group: 'a', progress: (percent, details) => progress.push({ percent, details }) }),
  ]);
  assert.equal(launches, 1);
  assert.equal(info.formats[1].height, 720);
  assert.equal('description' in info, false);
  assert.deepEqual(downloaded, { error: null, fileName: '标题.mp4' });
  assert.equal((await fs.stat(file)).mtime.toISOString(), '2022-11-04T00:00:00.000Z');
  assert.ok(progress.length >= 2 && progress.length < 20);
  assert.equal(progress.at(-1).percent, 99);
  assert.equal(progress.at(-1).details.eta, '00:01');
});

test('cancelling one group and quitting with other work active both wait for downloader exit', async (t) => {
  const children = new Map();
  let bothSpawned;
  const ready = new Promise((resolve) => { bothSpawned = resolve; });
  const worker = createDownloadWorker(() => {
    const child = launchTestWorker();
    child.on('message', (message) => {
      if (message.type !== 'child' || !message.pid) return;
      children.set(message.id, message.pid);
      if (children.size === 2) bothSpawned();
    });
    return child;
  });
  t.after(() => worker.close());
  const params = { ...toolParams('setInterval(() => {}, 1000)'), directory: os.tmpdir() };
  const download = worker.request('download', params, { group: 'a' });
  const parse = worker.request('metadata', params);
  const parseFailure = assert.rejects(parse);
  await ready;
  await worker.cancel('a');
  assert.ok((await download).error);
  const [first, second] = [children.get(1), children.get(2)];
  assert.throws(() => process.kill(first, 0), { code: 'ESRCH' });
  assert.doesNotThrow(() => process.kill(second, 0));
  await worker.close();
  await parseFailure;
  assert.throws(() => process.kill(second, 0), { code: 'ESRCH' });
  await assert.rejects(worker.request('metadata', params), /退出/);
});

test('forced utility loss reaps both the downloader and the independent muxer it spawned on Windows',
  { skip: process.platform !== 'win32', timeout: 25000 }, async (t) => {
    let utility;
    let rootPid;
    let muxerPid;
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const client = createDownloadWorker(() => {
      utility = launchTestWorker();
      utility.on('message', (message) => { if (message.type === 'child' && message.pid) rootPid = message.pid; });
      return utility;
    });
    t.after(async () => {
      try { await client.close(); }
      finally {
        for (const pid of [muxerPid, rootPid]) {
          if (pid) {
            try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          }
        }
      }
    });
    const script = [
      "const {spawn} = require('node:child_process');",
      "const helper = spawn(process.execPath, ['-e','setTimeout(()=>{},20000)'], {windowsHide:true,detached:true,stdio:'ignore'});",
      "console.log('[download] 1% at ' + helper.pid + ' ETA 00:10');",
      'setTimeout(()=>{},20000);',
    ].join(' ');
    const failed = assert.rejects(client.request('download', { ...toolParams(script), directory: os.tmpdir() },
      { progress: (_percent, details) => { muxerPid = Number(details.speed); started(); } }), /工作进程已退出/);
    await ready;
    assert.ok(rootPid && muxerPid);
    utility.kill();
    await failed;
    assert.throws(() => process.kill(rootPid, 0), { code: 'ESRCH' });
    try { process.kill(muxerPid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    // Diagnose a surviving muxer with the same executable and token.
    const probe = observeTaskkill();
    const killed = await terminateProcessTree({ pid: muxerPid, kill() {} }, { spawnProcess: probe.spawnProcess });
    if (!killed && probe.restricted()) return t.skip('Sandbox restricted taskkill');
    assert.fail('Muxer survived worker cleanup: ' + probe.diagnostic());
  });

test('IPC failure settles pending jobs on exit and a subsequent request can launch another worker', async () => {
  let launches = 0;
  const client = createDownloadWorker(() => {
    const child = new EventEmitter();
    const failed = ++launches === 1;
    child.kill = () => setImmediate(() => child.emit('exit', 1));
    child.postMessage = ({ id }) => {
      if (failed) throw new Error('closed');
      setImmediate(() => child.emit('message', { id, type: 'result', result: 'ok' }));
    };
    return child;
  });
  await assert.rejects(client.request('metadata', {}), /工作进程已退出/);
  assert.equal(await client.request('metadata', {}), 'ok');
  await client.close();
  assert.equal(launches, 2);
});

test('worker spawn error without exit settles pending work and close', { timeout: 1000 }, async () => {
  const child = Object.assign(new EventEmitter(), { postMessage() {}, kill: () => false });
  const client = createDownloadWorker(() => child);
  const failed = assert.rejects(client.request('metadata', {}), /spawn failed/);
  const closing = client.close();
  child.emit('error', new Error('spawn failed'));
  await Promise.all([failed, closing]);
});
