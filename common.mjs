/**
 * renew.mjs / power.mjs 公共模块：日志、脱敏、TG、截图、站点 API、
 * 登录、验证码（登录页明 DOM + 弹窗 <cap-widget>）。
 */
import fs from 'fs';
import path from 'path';

export function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** 账号脱敏：user@example.com → u***r@example.com */
export function maskAccount(raw) {
  const s = String(raw || '').trim();
  if (!s) return '未设置';
  if (s.includes('@')) {
    const [local, domain] = s.split('@');
    if (local.length <= 2) return `${local[0] || '*'}***@${domain}`;
    return `${local[0]}***${local[local.length - 1]}@${domain}`;
  }
  if (s.length <= 2) return `${s[0] || '*'}***`;
  return `${s[0]}***${s[s.length - 1]}`;
}

/** HTML 转义（Telegram parse_mode=HTML 时用，防 <div> 之类触发 400） */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 截图工厂：createShot(dir) 返回 (page, name) => 路径 */
export function createShot(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return async function shot(page, name) {
    const p = path.join(dir, name);
    try {
      await page.screenshot({ path: p, fullPage: true });
      log(`截图 ${name}`);
    } catch (e) {
      log(`截图失败 ${name}: ${e.message}`);
    }
    return p;
  };
}

/**
 * 带超时 + 重试的 fetch（TG 用）：网络抖动/5xx/429 自动重试，避免通知丢失或卡死到 job 超时。
 * 不把 URL 写进错误信息（URL 里含 bot token）。
 */
export async function fetchWithRetry(url, init = {}, { tries = 3, timeoutMs = 15000, backoffMs = 1500 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok || (r.status < 500 && r.status !== 429)) return r;
      lastErr = new Error(`HTTP ${r.status}`);
      if (i < tries) {
        let wait = backoffMs * i;
        if (r.status === 429) {
          const ra = Number((await r.clone().json().catch(() => ({})))?.parameters?.retry_after);
          if (ra > 0) wait = Math.min(ra, 30) * 1000;
        }
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = new Error(e.name === 'TimeoutError' ? '请求超时' : (e.message || '网络错误'));
      if (i < tries) await new Promise((res) => setTimeout(res, backoffMs * i));
    }
  }
  throw lastErr;
}

async function sendTgPhoto(chat, token, photoPath) {
  if (!photoPath || !fs.existsSync(photoPath) || fs.statSync(photoPath).size < 100) return;
  try {
    const form = new FormData();
    form.append('chat_id', chat);
    form.append('photo', new Blob([fs.readFileSync(photoPath)], { type: 'image/png' }), path.basename(photoPath));
    const r = await fetchWithRetry(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    if (!r.ok) log(`TG 图片发送失败: ${await r.text()}`);
    else log('TG 图片已发送');
  } catch (e) {
    log(`TG 图片发送异常: ${e.message}`);
  }
}

/**
 * TG 文本通知。
 * @param {string} text
 * @param {{photo?: string|null, parseMode?: string|null}} opts
 *   photo: 失败截图路径（renew 用）；parseMode: 'HTML'（power 用，调用方需先 escapeHtml）
 */
export async function tg(text, { photo = null, parseMode = null } = {}) {
  const token = process.env.TG_BOT_TOKEN;
  const chat = process.env.TG_CHAT_ID;
  if (!token || !chat) {
    log('未配置 TG_BOT_TOKEN/TG_CHAT_ID，跳过通知');
    return;
  }
  try {
    const r = await fetchWithRetry(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text,
        disable_web_page_preview: true,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
    });
    if (!r.ok) log(`TG 发送失败: ${await r.text()}`);
    else log('TG 文本已发送');
  } catch (e) {
    log(`TG 发送异常（非致命）: ${e.message}`);
  }
  if (photo) await sendTgPhoto(chat, token, photo);
}

/** 站点 API（走页面 fetch，带会话 cookie + XSRF） */
export async function api(page, p, method = 'GET', body) {
  return page.evaluate(
    async ({ p, method, body }) => {
      const token = document.cookie
        .split('; ')
        .find((c) => c.startsWith('XSRF-TOKEN='))
        ?.split('=')[1];
      const res = await fetch(p, {
        method,
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          ...(token ? { 'X-XSRF-TOKEN': decodeURIComponent(token) } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'include',
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text.slice(0, 400);
      }
      return { status: res.status, data };
    },
    { p, method, body }
  );
}

export function resolveExecutablePath() {
  const paths = [process.env.CHROME_PATH].filter(Boolean);
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/* ---------------- 诊断（验证码卡住时用） ---------------- */

const diagBuf = [];
function diagPush(line) {
  diagBuf.push(`${new Date().toISOString().slice(11, 23)} ${line}`.slice(0, 300));
  if (diagBuf.length > 60) diagBuf.shift();
}

/** 挂监听：控制台报错、请求失败、4xx/5xx 响应、以及任何发往 cap 域名的请求 */
export function attachDiagnostics(page) {
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type())) diagPush(`console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => diagPush(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    let host = '';
    try { host = new URL(r.url()).host; } catch {}
    diagPush(`requestfailed ${r.method()} ${host}${new URL(r.url()).pathname} : ${r.failure()?.errorText}`);
  });
  page.on('response', (r) => {
    let u;
    try { u = new URL(r.url()); } catch { return; }
    if (r.status() >= 400 || /cap/i.test(u.host)) diagPush(`resp ${r.status()} ${u.host}${u.pathname}`);
  });
}

/** 验证码失败时把页面状态和最近的网络/控制台事件打到日志 */
export async function dumpCaptchaDiag(page) {
  // 用 locator 取（可穿透 open shadow DOM）；document.querySelector 在 shadow 内永远是 null
  try {
    const el = page.locator('.captcha-trigger, div.captcha, cap-widget').first();
    const text = await el.innerText({ timeout: 3000 }).catch(() => '(取不到文本)');
    const html = await el.evaluate((n) => n.outerHTML, undefined, { timeout: 3000 }).catch(() => '(取不到 HTML)');
    const env = await page.evaluate(() => ({ webdriver: navigator.webdriver, ua: navigator.userAgent, lang: navigator.language }));
    log(`[diag] 验证码控件文本: ${JSON.stringify(String(text).slice(0, 120))} webdriver=${env.webdriver} lang=${env.lang}`);
    log(`[diag] 验证码控件 HTML: ${String(html).slice(0, 500)}`);
  } catch (e) {
    log(`[diag] 读取页面状态失败: ${e.message}`);
  }
  log(`[diag] 最近事件(${diagBuf.length}):\n${diagBuf.join('\n') || '(无)'}`);
}

/* ---------------- 验证码 ---------------- */

/**
 * 续费弹窗内的 <cap-widget>（data-cap-api-endpoint 指向 cap.aclclouds.com）。
 * 按 @cap.js/widget 源码机制三通道捕获 token：
 * solve 事件 detail.token / 元素属性 el.token / light DOM input[name="cap-token"]，
 * 同时监听 error 事件拿真实失败原因。
 */
export async function solveCapWidget(page, scope = '') {
  const root = scope ? `${scope} ` : '';
  const widget = page.locator(`${root}cap-widget, ${root}.auth-cap-widget`).first();
  await widget.waitFor({ state: 'visible', timeout: 20000 });

  // 预埋监听器（必须在点击之前）
  await page.evaluate(() => {
    window.__capSolveToken = null;
    window.__capError = null;
    const w = document.querySelector('cap-widget');
    if (w && !w.__capHooked) {
      w.__capHooked = true;
      w.addEventListener('solve', (e) => { window.__capSolveToken = (e && e.detail && e.detail.token) || null; });
      w.addEventListener('error', (e) => {
        const d = (e && e.detail) || {};
        window.__capError = (d.code || 'unknown') + ': ' + (d.message || '');
      });
    }
  });

  const readToken = () => page.evaluate(() => {
    if (window.__capSolveToken) return window.__capSolveToken;
    const w = document.querySelector('cap-widget');
    if (w && w.token) return w.token;
    return (document.querySelector('input[name="cap-token"]') || {}).value || '';
  });

  const existing = await readToken();
  if (existing && existing.length > 10) {
    log(`Cap 已有 token (len=${existing.length})`);
    return existing;
  }

  // 点击验证控件：真正的可点击节点是 cap-widget 的 open shadow root 内的
  // div.captcha-trigger[role="button"]（2026-10-11 浏览器实测确认）。
  // 教训：选择器漏了 [role="button"] 会导致点到空处，solve() 从未触发，token 永远等不来。
  // Playwright locator 可穿透 open shadow DOM。
  const btn = widget.locator('button, [role="button"], [role="checkbox"], .cap-checkbox, .captcha-trigger').first();
  let clicked = false;
  if ((await btn.count()) > 0) {
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 10000 }).catch(() => {});
    clicked = true;
  } else {
    clicked = await page.evaluate(() => {
      const w = document.querySelector('cap-widget');
      const sr = w && w.shadowRoot;
      const b = (sr && sr.querySelector('[role="button"], button, [role="checkbox"], .cap-checkbox, .captcha-trigger'))
        || document.querySelector('.auth-cap-widget [role="button"]');
      if (b) { b.click(); return true; }
      return false;
    });
  }
  log(`已点击弹窗 Cap 控件 (clicked=${clicked})，等待 PoW 求解...`);

  // 注意：waitForFunction 签名是 (fn, arg, options)，options 必须放第三个参数
  const result = await page.waitForFunction(() => {
    if (window.__capError) return { error: window.__capError };
    if (window.__capSolveToken) return { token: window.__capSolveToken };
    const w = document.querySelector('cap-widget');
    if (w && w.token) return { token: w.token };
    const v = ((document.querySelector('input[name="cap-token"]') || {}).value) || '';
    if (v.length > 10) return { token: v };
    return null;
  }, undefined, { timeout: 120000 }).then((h) => h.jsonValue()).catch(() => null);

  if (result && result.error) throw new Error(`Cap 组件报错: ${result.error}`);
  const token = (result && result.token) || '';
  if (!token || token.length < 10) throw new Error('Cap 验证码超时未获得 token');
  log(`弹窗 Cap 验证通过, token len=${token.length}`);
  return token;
}

/**
 * 登录页验证码文案判定（纯函数，可单测）。
 * 成功态：法语 Vérifié / 英语 You're human（checkbox 版）。
 * 注意英文版初始文案是 "Verify you're human"，必须排除 "verify" 才能判定成功。
 * @returns {'ok'|'error'|null}
 */
export function classifyLoginCaptchaText(raw) {
  const t = String(raw || '').toLowerCase();
  if (/vérifié/.test(t) || (/\byou['’]re human\b/.test(t) && !/verify/.test(t))) return 'ok';
  if (/erreur|error/.test(t)) return 'error';
  return null;
}

/**
 * 登录页验证码。
 * 两种形态（2026-10-11 实测）：
 * - 明 DOM：div.captcha > div.captcha-trigger[role="button"]，
 *   点击后 "Vérifier que vous êtes humain" → "Vérification…" → "Vérifié"
 * - checkbox（en-US 下）："Verify you're human" → "You're human"（带绿勾）
 */
export async function solveLoginCaptcha(page) {
  const trigger = page.locator('.captcha-trigger, div.captcha [role="button"]').first();
  if ((await trigger.count()) > 0) {
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.click({ timeout: 10000 });
    log('已点击登录页 Cap，等待验证通过...');
    // 注意：checkbox 版的 .captcha-trigger 位于 cap-widget 的 open shadow root 内，
    // document.querySelector 穿不透 shadow DOM（永远返回 null），必须用 locator
    //（Playwright 可穿透）取 innerText 轮询；判定逻辑复用 classifyLoginCaptchaText
    const label = page.locator('.captcha-trigger, div.captcha [role="button"]').first();
    const deadline = Date.now() + 120000;
    let st = null;
    while (Date.now() < deadline && !st) {
      const t = await label.innerText().catch(() => '');
      st = classifyLoginCaptchaText(t);
      if (!st) await page.waitForTimeout(1000);
    }
    if (st === 'error') throw new Error('登录页 Cap 返回 Erreur');
    if (st !== 'ok') throw new Error('登录页 Cap 超时未完成');
    log('登录页 Cap 通过');
    return;
  }
  // 兜底：旧版 <cap-widget>
  if ((await page.locator('cap-widget, .auth-cap-widget').count()) > 0) {
    await solveCapWidget(page);
    return;
  }
  throw new Error('登录页未找到验证码控件');
}

/* ---------------- 登录 ---------------- */

export async function loggedIn(page) {
  if (/\/dashboard/i.test(page.url())) return true;
  const r = await api(page, '/api/client/account');
  return r.status === 200 && r.data?.object === 'user';
}

/**
 * 登录（复用 auth.json 会话）。
 * @param {import('playwright').Page} page
 * @param {(page, name) => Promise<string>} shot 截图函数
 * @param {{base: string, user: string, pass: string, authPath: string}} opts
 */
export async function login(page, shot, { base, user, pass, authPath }) {
  log(`登录 ${base}（${maskAccount(user)}）`);
  attachDiagnostics(page);
  await page.goto(`${base}/auth/login`, { waitUntil: 'networkidle' }).catch(() =>
    page.goto(`${base}/auth/login`, { waitUntil: 'domcontentloaded' })
  );
  await page.waitForTimeout(1500);
  if (await loggedIn(page)) {
    log('已有会话，跳过登录');
    return;
  }
  if (fs.existsSync(authPath)) {
    fs.unlinkSync(authPath);
    log('旧会话失效，已删除');
  }

  await page.waitForSelector('#username', { timeout: 15000 });
  await page.fill('#username', user);
  await page.fill('#password', pass);
  await shot(page, '01-login.png');

  let authed = false;
  for (let i = 0; i < 4 && !authed; i++) {
    try {
      await solveLoginCaptcha(page);
      authed = true;
    } catch (e) {
      log(`登录验证码失败(${i + 1}/4): ${e.message}`);
      await dumpCaptchaDiag(page);
      await shot(page, `01-login-retry${i + 1}.png`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await page.fill('#username', user);
      await page.fill('#password', pass);
    }
  }
  if (!authed) throw new Error('登录验证码多次失败');

  await page.click("button[type='submit'], .auth-submit-btn");
  try {
    await page.waitForURL(/\/dashboard/, { timeout: 30000 });
  } catch {
    const errText = await page.locator('.auth-error, .alert, [class*=error]').first().innerText().catch(() => '');
    throw new Error(`登录后未进入 dashboard (url=${page.url()}) ${errText}`);
  }
  await page.context().storageState({ path: authPath });
  log(`登录成功，会话写入 ${authPath}`);
}
