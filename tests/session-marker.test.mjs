import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import extension from '../extensions/session-marker.ts';

// Each test replaces only this subprocess's environment. Never use the real index.
async function fixture(run, { name = 'Example session', entries = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mark-test-'));
  const keys = ['USERPROFILE', 'HOME', 'HERDR_ENV', 'HERDR_SOCKET_PATH', 'PI_CODING_AGENT_DIR'];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  try {
    process.env.USERPROFILE = root;
    process.env.HOME = root;
    process.env.HERDR_ENV = '0';
    delete process.env.HERDR_SOCKET_PATH;
    process.env.PI_CODING_AGENT_DIR = path.join(root, '.pi', 'profiles', 'eigenflux');
    const commands = new Map();
    const notices = [];
    let currentName = name;
    extension({
      registerCommand: (key, command) => commands.set(key, command),
      getSessionName: () => currentName,
      setSessionName: value => { currentName = value; },
    });
    const session = path.join(root, 'example.jsonl');
    fs.writeFileSync(session, '{"type":"session","id":"example-session"}\n');
    const ctx = {
      hasUI: true,
      cwd: root,
      ui: { notify: (message, level) => notices.push({ message, level }) },
      sessionManager: {
        getSessionFile: () => session,
        getSessionId: () => 'example-session',
        getEntries: () => entries,
      },
    };
    const index = path.join(root, '.pi', 'agent', 'marked-sessions.json');
    await run({
      root, session, ctx, commands, notices, index,
      name: () => currentName,
      rows: () => JSON.parse(fs.readFileSync(index, 'utf8')),
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('registers the existing mark and unmark commands without adding new commands', async () => {
  await fixture(async ({ commands }) => {
    assert.deepEqual([...commands.keys()], ['mark', 'unmark']);
    assert.deepEqual(commands.get('mark').getArgumentCompletions('li').map(item => item.value), ['list']);
  });
});

test('mark writes the existing Herdr-compatible schema in the temporary home', async () => {
  await fixture(async ({ commands, ctx, rows, session, root, name }) => {
    await commands.get('mark').handler('', ctx);
    const [row] = rows();
    assert.equal(row.id, 'example-session');
    assert.equal(row.path, session);
    assert.equal(row.title, 'Example session');
    assert.equal(row.profile, 'eigenflux');
    assert.equal(row.command, 'pi-2');
    assert.equal(row.resume_cmd, `pi-2 --resume "${session}"`);
    assert.equal(row.cwd, root);
    assert.equal(typeof row.created_at, 'number');
    assert.equal(typeof row.updated_at, 'number');
    assert.equal(name(), '★ Example session');
  });
});

test('mark updates rather than duplicates and preserves creation time', async () => {
  await fixture(async ({ commands, ctx, rows, name }) => {
    await commands.get('mark').handler('', ctx);
    const created = rows()[0].created_at;
    await commands.get('mark').handler('New title', ctx);
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].title, 'New title');
    assert.equal(rows()[0].created_at, created);
    assert.equal(name(), '★ New title');
    await commands.get('mark').handler('', ctx);
    assert.equal(name(), '★ New title');
  });
});

test('mark list is read-only and reports saved entries', async () => {
  await fixture(async ({ commands, ctx, index, notices }) => {
    await commands.get('mark').handler('Listed title', ctx);
    const before = fs.readFileSync(index, 'utf8');
    await commands.get('mark').handler('list', ctx);
    assert.equal(fs.readFileSync(index, 'utf8'), before);
    assert.ok(notices.at(-1).message.includes('Listed title'));
  });
});

test('unmark removes only the bookmark and leaves the session file intact', async () => {
  await fixture(async ({ commands, ctx, rows, session, name }) => {
    const original = fs.readFileSync(session, 'utf8');
    await commands.get('mark').handler('', ctx);
    await commands.get('unmark').handler('', ctx);
    assert.deepEqual(rows(), []);
    assert.equal(name(), 'Example session');
    assert.equal(fs.readFileSync(session, 'utf8'), original);
  });
});

test('an unmarked session does not create an empty index', async () => {
  await fixture(async ({ commands, ctx, index }) => {
    await commands.get('unmark').handler('', ctx);
    assert.equal(fs.existsSync(index), false);
  });
});

test('an unsaved session is not bookmarked', async () => {
  await fixture(async ({ commands, ctx, index, notices }) => {
    ctx.sessionManager.getSessionFile = () => undefined;
    await commands.get('mark').handler('', ctx);
    assert.equal(fs.existsSync(index), false);
    assert.equal(notices.at(-1).level, 'warning');
  });
});

test('a nameless session uses the first user message as title', async () => {
  await fixture(async ({ commands, ctx, rows }) => {
    await commands.get('mark').handler('', ctx);
    assert.equal(rows()[0].title, 'A synthetic user message');
  }, {
    name: '',
    entries: [{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'A synthetic user message\nSecond line' }] } }],
  });
});
