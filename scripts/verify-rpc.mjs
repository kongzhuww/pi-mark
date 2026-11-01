// Uses a real installed Pi CLI, but only synthetic sessions and slash commands.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const cli = process.env.PI_MARK_PI_CLI;
if (!cli || !path.isAbsolute(cli) || !fs.statSync(cli).isFile()) {
  throw new Error('Set PI_MARK_PI_CLI to the absolute path of an installed Pi dist/cli.js');
}
const repo = fileURLToPath(new URL('../', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mark-rpc-'));
const agentDir = path.join(root, '.pi', 'agent');
fs.mkdirSync(agentDir, { recursive: true });
const fixture = path.join(root, 'fixture.jsonl');
const stamp = new Date().toISOString();
fs.writeFileSync(fixture, [
  { type: 'session', version: 3, id: 'mark-rpc-fixture', timestamp: stamp, cwd: root },
  { type: 'message', id: 'abc12345', parentId: null, timestamp: stamp, message: { role: 'user', content: 'Synthetic saved session', timestamp: Date.now() } },
  { type: 'session_info', id: 'def12345', parentId: 'abc12345', timestamp: stamp, name: 'Original test name' },
].map(row => JSON.stringify(row)).join('\n') + '\n');

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith('PI_') || key.startsWith('HERDR_') || /(?:TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIALS)$/i.test(key)) delete env[key];
}
Object.assign(env, { USERPROFILE: root, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0', HERDR_ENV: '0' });
const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--offline', '--no-mcp', '--no-context-files', '--no-tools', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-extensions', '--no-approve', '-e', repo, '--session', fixture], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '', stderr = '', serial = 0, failure;
const pending = new Map();
const events = [];
function fail(error) {
  failure = error;
  for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(error); }
  pending.clear();
  child.kill();
}
child.on('error', fail);
child.on('exit', code => {
  if (pending.size) fail(new Error(`Pi exited with pending requests: ${code}; ${stderr}`));
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, '');
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { fail(new Error('Non-JSON data on RPC stdout')); return; }
    events.push(event);
    if (event.type === 'agent_start') { fail(new Error('Unexpected model run')); return; }
    const wait = pending.get(event.id);
    if (event.type === 'response' && wait) {
      pending.delete(event.id);
      clearTimeout(wait.timer);
      event.success ? wait.resolve(event) : wait.reject(new Error(event.error));
    }
  }
});
function call(type, params = {}) {
  if (failure) return Promise.reject(failure);
  const id = `probe-${++serial}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`Timeout: ${type}; ${stderr}`)), 30000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, type, ...params }) + '\n');
  });
}
async function command(message) {
  const result = await call('prompt', { message });
  assert.equal(result.data.disposition, 'handled');
}
const index = path.join(agentDir, 'marked-sessions.json');
const rows = () => JSON.parse(fs.readFileSync(index, 'utf8'));
try {
  const commands = (await call('get_commands')).data.commands;
  for (const name of ['mark', 'unmark']) assert.equal(commands.filter(c => c.name === name).length, 1);
  console.log('PASS actual Pi package discovery: mark/unmark registered once');
  for (const text of ['/mark RPC bookmark', '/mark Updated RPC bookmark', '/mark list']) await command(text);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].title, 'Updated RPC bookmark');
  assert.ok(rows()[0].resume_cmd.includes(' --session '));
  assert.equal(path.resolve(rows()[0].path), path.resolve(fixture));
  assert.equal((await call('get_state')).data.sessionName, '★ Updated RPC bookmark');
  assert.ok(fs.readFileSync(fixture, 'utf8').includes('★ Updated RPC bookmark'));
  console.log('PASS saved session: mark/update/list, valid path, persisted star name');
  await command('/unmark');
  assert.deepEqual(rows(), []);
  assert.equal((await call('get_state')).data.sessionName, 'Updated RPC bookmark');
  assert.ok(fs.existsSync(fixture));
  console.log('PASS unmark preserves the session file');
  for (const invalid of ['{broken', '{}', '[null]']) {
    fs.writeFileSync(index, invalid);
    for (const text of ['/mark blocked', '/mark list', '/unmark']) {
      const start = events.length;
      await command(text);
      assert.equal(fs.readFileSync(index, 'utf8'), invalid);
      assert.ok(events.slice(start).some(e => e.type === 'extension_ui_request' && e.method === 'notify' && e.notifyType === 'error'));
    }
  }
  console.log('PASS invalid index: all commands report an error without rewriting');
  fs.writeFileSync(index, '[]');
  await call('new_session');
  const before = (await call('get_state')).data;
  assert.ok(before.sessionFile && !fs.existsSync(before.sessionFile));
  const start = events.length;
  await command('/mark Empty-session probe');
  assert.deepEqual(rows(), []);
  assert.equal((await call('get_state')).data.sessionName, before.sessionName);
  assert.ok(events.slice(start).some(e => e.method === 'notify' && e.notifyType === 'warning'));
  console.log('PASS fresh empty session is rejected without an index or name change');
  assert.equal(events.filter(e => e.type === 'agent_start').length, 0);
  child.stdin.end();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Shutdown timeout')); }, 10000);
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Exit ${code}; ${stderr}`)); });
  });
  console.log('PASS no model run; Pi exited cleanly');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
  }
  fs.rmSync(root, { recursive: true, force: true });
}
