import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<div id="session-items"></div>', { runScripts: 'outside-only' });
const w = dom.window;
try {
  Object.assign(w, {
    state: { sessions: [], seenSessionIds: new Set() }, SESSION_PAGE: 30, STATUS_LABEL: { error: '失败' },
    $: selector => w.document.querySelector(selector),
    $$: (selector, root = w.document) => [...root.querySelectorAll(selector)],
    esc: value => String(value), formatChatTitle: () => '测试群', chatNameOf: () => '测试群',
    fmtTime: () => '12:00', fmtTokens: value => value
  });
  const source = fs.readFileSync(new URL('../ui/app/02-sse-sessions.js', import.meta.url), 'utf8');
  w.eval(source.slice(source.indexOf('function sessionTriggerLabel'), source.indexOf('function renderSessionDetail')));
  for (const [retryAllowed, sent, count] of [[false, [], 0], [true, [], 1], [false, [{ text: '已发送' }], 0]]) {
    w.state.sessions = [{ id: 'retry-case', chatKey: 'group:456', status: 'error', retryAllowed, sent }];
    w.renderSessionList();
    assert.equal(w.document.querySelectorAll('.session-retry-btn').length, count);
  }
  console.log('PASS session retry action follows server permission; unsafe or previously sent runs cannot be replayed');
} finally { w.close(); }
