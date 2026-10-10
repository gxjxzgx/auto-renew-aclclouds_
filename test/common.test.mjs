import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskAccount, escapeHtml, fetchWithRetry, classifyLoginCaptchaText } from '../common.mjs';

test('classifyLoginCaptchaText: 成功/初始/错误态', () => {
  // 法语明 DOM 版
  assert.equal(classifyLoginCaptchaText('Vérifié'), 'ok');
  assert.equal(classifyLoginCaptchaText('Vérifier que vous êtes humain'), null);
  assert.equal(classifyLoginCaptchaText('Vérification…'), null);
  // 英语 checkbox 版：成功是 "You're human"，初始 "Verify you're human" 不能误判
  assert.equal(classifyLoginCaptchaText("You're human"), 'ok');
  assert.equal(classifyLoginCaptchaText("You're human\nCap"), 'ok');
  assert.equal(classifyLoginCaptchaText("Verify you're human"), null);
  assert.equal(classifyLoginCaptchaText(''), null);
  assert.equal(classifyLoginCaptchaText(null), null);
  // 错误态
  assert.equal(classifyLoginCaptchaText('Erreur de vérification'), 'error');
});

test('maskAccount: 邮箱 / 短名 / 空值', () => {
  assert.equal(maskAccount('user@example.com'), 'u***r@example.com');
  assert.equal(maskAccount('ab@x.com'), 'a***@x.com');
  assert.equal(maskAccount('alice'), 'a***e');
  assert.equal(maskAccount(''), '未设置');
  assert.equal(maskAccount(null), '未设置');
});

test('escapeHtml: 转义 & < >', () => {
  assert.equal(escapeHtml('<div a="1"> & </div>'), '&lt;div a="1"&gt; &amp; &lt;/div&gt;');
  assert.equal(escapeHtml(undefined), '');
});

function mockFetch(responses) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const res = (status, body = {}) => new Response(JSON.stringify(body), { status });

test('fetchWithRetry: 5xx 后重试成功', async () => {
  const m = mockFetch([res(502), res(200)]);
  try {
    const r = await fetchWithRetry('https://x', {}, { tries: 3, backoffMs: 1 });
    assert.equal(r.status, 200);
    assert.equal(m.calls.length, 2);
  } finally { m.restore(); }
});

test('fetchWithRetry: 4xx 不重试', async () => {
  const m = mockFetch([res(400), res(200)]);
  try {
    const r = await fetchWithRetry('https://x', {}, { tries: 3, backoffMs: 1 });
    assert.equal(r.status, 400);
    assert.equal(m.calls.length, 1);
  } finally { m.restore(); }
});

test('fetchWithRetry: 全部网络错误后抛出，且错误信息不含 URL', async () => {
  const m = mockFetch([new Error('boom'), new Error('boom'), new Error('boom')]);
  try {
    await assert.rejects(
      fetchWithRetry('https://api.telegram.org/botSECRET/sendMessage', {}, { tries: 3, backoffMs: 1 }),
      (e) => !/SECRET/.test(e.message)
    );
    assert.equal(m.calls.length, 3);
  } finally { m.restore(); }
});

test('fetchWithRetry: 429 按 retry_after 重试', async () => {
  const m = mockFetch([res(429, { parameters: { retry_after: 0 } }), res(200)]);
  try {
    const r = await fetchWithRetry('https://x', {}, { tries: 2, backoffMs: 1 });
    assert.equal(r.status, 200);
  } finally { m.restore(); }
});
