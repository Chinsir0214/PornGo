'use strict';

const { spawn } = require('node:child_process');

// Preserve taskkill diagnostics before terminateProcessTree falls back to a direct kill.
function observeTaskkill() {
  const chunks = [];
  let status;
  let failure;
  function spawnProcess(command, args, options) {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => chunks.push(chunk));
    child.once('error', (error) => { failure = error; });
    child.once('close', (code) => { status = code; });
    return child;
  }
  function diagnostic() {
    const bytes = Buffer.concat(chunks);
    return [failure?.message, bytes.toString('utf8'), bytes.toString('utf16le'),
      // Some localized Windows consoles emit legacy Chinese text.
      new TextDecoder('gb18030').decode(bytes)].join('\n');
  }
  function restricted() {
    return ['EPERM', 'EACCES'].includes(failure?.code) || [5, 1314, 1326, 1385].includes(status)
      || /access (?:is )?denied|restricted token|logon failure|logon type|privilege is not held|拒绝访问|访问被拒绝|登录失败|登陆失败|登录类型|受限令牌|用户名或密码不正确|unknown user name or bad password|0x80070005|0x80070569/i.test(diagnostic());
  }
  return { spawnProcess, diagnostic, restricted };
}

module.exports = { observeTaskkill };
