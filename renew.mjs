#!/usr/bin/env node
/**
 * ACLClouds 免费服自动续期 —— 2026-10-11 重写版
 *
 * 真实流程（2026-10-11 浏览器实测确认）：
 *  1. /auth/login 登录。注意：登录页验证码已换成明 DOM 实现
 *     div.captcha > div.captcha-trigger[role="button"]（点击 → "Vérifié"），
 *     不是 <cap-widget> / shadow DOM。
 *  2. GET /api/client 发现服务（identifier / uuid / expires_at）。
 *  3. 先试 POST /api/client/servers/{id}/upgrade/renew：
 *       200 → 成功；400 renewal_not_available → 未到窗口，跳过；
 *       403 captcha_required → 走第 4 步弹窗流程；其他 → 失败。
 *  4. 弹窗流程：/server/{id} 点横幅上的 "Renouveler" →
 *     "Confirmation anti-robot" 弹窗（内为 <cap-widget
 *     data-cap-api-endpoint="https://cap.aclclouds.com/..."> + 隐藏 input[name="cap-token"]，
 *     真正可点击的是其 open shadow root 内的 div.captcha-trigger[role="button"]）→
 *     点击 widget 求解 → token 签发后站点自动提交续费（弹窗无确认按钮）→
 *     轮询 /api/client 确认 expires_at 后移。
 *  5. 每台服务按 bot-hosting 风格模板发一条 TG 通知（含机器状态/运行时长/脚本耗时）。
 *
 * DRY_RUN=1：只做登录 + 发现 + 状态读取 + 弹窗选择器校验（打开弹窗后点 Annuler 关闭），
 * 不发 POST renew、不点确认按钮；TG 消息带 DRY_RUN 标记。
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { setupProxy } from './proxy_helper.mjs';
import {
  log, maskAccount, createShot, tg, api, resolveExecutablePath,
  solveCapWidget, login,
} from './common.mjs';

const BASE = (process.env.ACL_BASE_URL || 'https://aclclouds.com').replace(/\/+$/, '');
const USER = process.env.ACL_USERNAME || process.env.ACL_EMAIL || '';
const PASS = process.env.ACL_PASSWORD || '';
const SERVER_ID = process.env.ACL_SERVER_ID || '';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const AUTH = path.resolve(process.env.ACL_AUTH_STATE || 'auth.json');
const SHOT = path.resolve('shots');

// 续期窗口：到期前 2 天（窗口外无 Renew 入口，API 返回 renewal_not_available）
const RENEW_WINDOW_MS = 2 * 86400000;

const shot = createShot(SHOT);

/* ---------------- TG 模板 ---------------- */

/** 北京时间 "2026-10-11 02:31:00" */
function beijingDateTime(d = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce((o, p) => ((o[p.type] = p.value), o), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** 到期日 "2026/10/12"（北京时间） */
function beijingDate(iso) {
  if (!iso) return '未知';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '未知';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).reduce((o, p) => ((o[p.type] = p.value), o), {});
  return `${parts.year}/${parts.month}/${parts.day}`;
}

/** 时长 → "2天9小时" / "24小时" / "35分钟" */
function fmtDur(ms) {
  if (ms == null || isNaN(ms)) return '未知';
  if (ms <= 0) return '0分钟';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时`;
  return `${Math.max(m, 1)}分钟`;
}

/** 脚本耗时 → "46秒" / "1分12秒" */
function fmtScriptDur(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}秒`;
  return `${Math.floor(s / 60)}分${s % 60}秒`;
}

function stateLine(state) {
  switch ((state || '').toLowerCase()) {
    case 'running': return '🟢 运行中';
    case 'offline':
    case 'stopped': return '🔴 已停止';
    case 'starting': return '🟡 启动中';
    case 'stopping': return '🟡 停止中';
    default: return '⚪ 未知';
  }
}

/** 可续期时间：窗口 = 到期前 2 天 */
function renewInText(expiresAt) {
  if (!expiresAt) return '未知';
  const windowAt = new Date(expiresAt).getTime() - RENEW_WINDOW_MS;
  if (isNaN(windowAt)) return '未知';
  const diff = windowAt - Date.now();
  if (diff <= 0) return '现在可续';
  return `${fmtDur(diff)}后`;
}

function buildTgMessage({ outcome, server, resources, scriptSec, executedAt, error, net }) {
  const statusLine =
    outcome === 'renewed' ? '✅ 续期成功' :
    outcome === 'skipped' ? '⏳ 未到续期窗口' :
    outcome === 'dryrun' ? '🧪 DRY_RUN 预览（未真正续期）' :
    outcome === 'unconfirmed' ? '❓ 续期结果无法确认' : '❌ 续期失败';
  const state = resources?.state || 'unknown';
  const uptime =
    resources?.uptimeMs != null && state === 'running' ? fmtDur(resources.uptimeMs) : '—';
  const lines = [
    'ACLClouds 续期通知',
    '',
    statusLine,
    `👤 登录账户: ${maskAccount(USER)}`,
    `🌐 出口IP: ${net?.exitIp || '未知'}（${net?.mode || '未知'}）`,
    `📅 到期时间: ${beijingDate(server?.expiresAt)}`,
    `⏱️ 续期时间: ${outcome === 'failed' ? '未知' : renewInText(server?.expiresAt)}`,
    `🖥️ 机器状态: ${stateLine(state)}`,
    `⏳ 运行时长: ${uptime}`,
    `🕒 脚本耗时: ${fmtScriptDur(scriptSec)}`,
    `⏱️ 执行时间: ${executedAt}`,
  ];
  if (outcome === 'failed' && error) lines.push(`⚠️ 原因: ${String(error).slice(0, 200)}`);
  if (outcome === 'skipped' && server?.expiresAt) lines.push(`ℹ️ 剩余时间: ${fmtDur(new Date(server.expiresAt).getTime() - Date.now())}`);
  return lines.join('\n');
}

/* ---------------- 发现服务 ---------------- */

async function findServer(page, id, uuid) {
  const r = await api(page, '/api/client');
  if (r.status !== 200 || !Array.isArray(r.data?.data)) return null;
  const item = r.data.data.find(
    (x) => x?.object === 'server' && x.attributes &&
      (x.attributes.identifier === id || x.attributes.uuid === id || x.attributes.uuid === uuid)
  );
  if (!item) return null;
  return {
    id: item.attributes.identifier,
    uuid: item.attributes.uuid,
    name: item.attributes.name || item.attributes.identifier,
    expiresAt: item.attributes.expires_at || null,
  };
}

async function discover(page) {
  const servers = [];
  const r = await api(page, '/api/client');
  if (r.status === 200 && Array.isArray(r.data?.data)) {
    for (const item of r.data.data) {
      if (item.object === 'server' && item.attributes) {
        servers.push({
          id: item.attributes.identifier,
          uuid: item.attributes.uuid,
          name: item.attributes.name || item.attributes.identifier,
          expiresAt: item.attributes.expires_at || null,
        });
      }
    }
  }
  log(`发现服务: ${servers.map((s) => `${s.name}(${s.id}) 到期:${s.expiresAt || '未知'}`).join(', ') || '(无)'}`);
  return servers;
}

async function getResources(page, id) {
  try {
    const r = await api(page, `/api/client/servers/${id}/resources`);
    if (r.status !== 200) {
      log(`resources HTTP ${r.status} (${id})`);
      return { state: 'unknown', uptimeMs: null };
    }
    return {
      state: String(r.data?.attributes?.current_state || 'unknown').toLowerCase(),
      // Pterodactyl resources 接口：uptime 在 attributes.resources.uptime（毫秒）
      uptimeMs: r.data?.attributes?.resources?.uptime ?? null,
    };
  } catch (e) {
    log(`resources 异常 (${id}): ${e.message}`);
    return { state: 'unknown', uptimeMs: null };
  }
}

/* ---------------- 续期 ---------------- */

function classifyRenew(r) {
  if (r.status === 200) {
    return { ok: true, skip: false, captcha: false, text: `续期成功 ${JSON.stringify(r.data).slice(0, 120)}` };
  }
  if (r.status === 400 && (r.data?.error === 'renewal_not_available' || r.data?.code === 'renewal_not_available')) {
    return { ok: true, skip: true, captcha: false, text: '未到续期窗口' };
  }
  const blob = JSON.stringify(r.data);
  if (r.status === 403 && /captcha_required/i.test(blob)) {
    return { ok: false, skip: false, captcha: true, text: 'HTTP 403 captcha_required' };
  }
  return { ok: false, skip: false, captcha: false, text: `HTTP ${r.status} ${blob.slice(0, 180)}` };
}

/**
 * 弹窗续期：/server/{id} → 点 "Renouveler" → "Confirmation anti-robot" 弹窗 →
 * 解 Cap → 轮询 expires_at 后移。
 *
 * 注意（2026-10-11 浏览器实测确认）：该弹窗**没有确认按钮**——Cap token 一经签发，
 * 处于 "Renouvellement..." 待定状态的续费请求会被站点自动提交，对话框自行关闭。
 * 之前版本误以为求解后会出现确认按钮，是错的。
 */
async function renewViaDialog(page, server) {
  const { id, name } = server;
  // 续期前没读到到期时间：照常走续期流程，只是最后无法用"后移"判定，
  // 结果标"无法确认"而不是误判成功
  const before = server.expiresAt ? new Date(server.expiresAt).getTime() : 0;
  if (!before) log('⚠️ 续期前未读到到期时间，照常续期，结果将标为"无法确认"');

  await page.goto(`${BASE}/server/${id}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000);

  const renewBtn = page.locator('button:has-text("Renouveler"), button:has-text("Renew")').first();
  await renewBtn.waitFor({ state: 'visible', timeout: 20000 });
  await shot(page, '05-before-renew.png');
  await renewBtn.scrollIntoViewIfNeeded().catch(() => {});
  await renewBtn.click({ timeout: 10000 });
  log('已点击 Renouveler，等待 Anti-bot confirmation 弹窗...');

  const dialog = page.locator('div[role="dialog"]').filter({ has: page.locator('cap-widget, .auth-cap-widget') }).first();
  await dialog.waitFor({ state: 'visible', timeout: 20000 });
  log('弹窗已出现，开始 Cap 验证...');
  await shot(page, '05-dialog.png');

  // token 签发后站点自动提交续费、对话框自行关闭；求解抛错也先轮询一次，
  // 防止 token 已签发但捕获竞态导致误判失败
  let solved = false;
  try {
    await solveCapWidget(page, 'div[role="dialog"]');
    solved = true;
  } catch (e) {
    log(`Cap 求解未确认，先检查是否已自动提交: ${e.message}`);
  }
  await shot(page, '05-dialog-solved.png');

  // 无基准可比：等弹窗关闭（站点自动提交续费后对话框自行关闭），读一次到期时间，
  // 标"无法确认"（无法判断是否真的后移）
  if (!before) {
    // 验证码根本没过：弹窗不会自己关闭，直接失败，别白等 90 秒后误报"无法确认"
    if (!solved) throw new Error('Cap 验证码超时未获得 token');
    await dialog.waitFor({ state: 'hidden', timeout: 90000 }).catch(() => {});
    await shot(page, '06-result.png');
    const item = await findServer(page, id, server.uuid).catch(() => null);
    if (item?.expiresAt) server.expiresAt = item.expiresAt;
    log(`⚠️ 续期流程已走完，但续期前未读到到期时间，无法确认是否成功（当前到期: ${server.expiresAt || '未知'}）`);
    return 'unconfirmed';
  }

  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(5000);
    try {
      const item = await findServer(page, id, server.uuid);
      const exp = item?.expiresAt || null;
      if (exp && new Date(exp).getTime() > before) {
        server.expiresAt = exp;
        log(`续期成功，新到期: ${exp}`);
        await shot(page, '06-result.png');
        return 'renewed';
      }
    } catch { /* 继续轮询 */ }
    const dlgText = await dialog.innerText().catch(() => '');
    if (/error|failed|échec|erreur/i.test(dlgText)) {
      await shot(page, '05-dialog-error.png');
      throw new Error(`弹窗报错: ${dlgText.slice(0, 200)}`);
    }
  }
  await shot(page, '05-dialog-timeout.png');
  throw new Error(solved ? 'token 已签发但 120s 内未检测到到期时间后移' : 'Cap 验证码超时未获得 token');
}

async function tryRenew(page, server) {
  const { id, name } = server;
  log(`检查续期: ${name} (${id})`);

  // 先试 API：便宜，未到窗口直接 skip，不进弹窗
  const r = await api(page, `/api/client/servers/${id}/upgrade/renew`, 'POST', {});
  const c = classifyRenew(r);

  if (c.ok && c.skip) {
    log(`API 结果: 未到续期窗口（${name}）`);
    return 'skipped';
  }
  if (c.ok) {
    const item = await findServer(page, id, server.uuid);
    if (item?.expiresAt) server.expiresAt = item.expiresAt;
    log(`API 续期成功: ${c.text}`);
    return 'renewed';
  }
  if (c.captcha) {
    log('API 被 403 captcha_required 拦截，走弹窗流程...');
    return await renewViaDialog(page, server); // 'renewed' | 'unconfirmed'
  }
  throw new Error(c.text);
}

/**
 * DRY_RUN 校验：打开服务页确认 Renouveler 按钮存在 → 打开弹窗确认
 * cap-widget 存在 → 点 Annuler 关闭。不发 POST、不点确认，不改变任何状态。
 */
async function dryRunCheck(page, server) {
  const { id, name } = server;
  log(`[DRY_RUN] 校验弹窗选择器: ${name} (${id})`);
  await page.goto(`${BASE}/server/${id}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000);
  const renewBtn = page.locator('button:has-text("Renouveler"), button:has-text("Renew")').first();
  const btnVisible = await renewBtn.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
  if (!btnVisible) {
    // 刚续过费、未到窗口时 Renouveler 按钮根本不存在——这不是失败，跳过弹窗校验
    log('[DRY_RUN] Renouveler 按钮不存在（未到续期窗口），跳过弹窗校验 ✓');
    return;
  }
  await renewBtn.scrollIntoViewIfNeeded().catch(() => {});
  await renewBtn.click({ timeout: 10000 });
  const dialog = page.locator('div[role="dialog"]').filter({ has: page.locator('cap-widget, .auth-cap-widget') }).first();
  await dialog.waitFor({ state: 'visible', timeout: 20000 });
  log('[DRY_RUN] Confirmation 弹窗 + cap-widget 存在 ✓');
  await shot(page, '05-dryrun-dialog.png');
  const annuler = dialog.locator('button:has-text("Annuler"), button:has-text("Cancel")').first();
  if ((await annuler.count()) > 0) {
    await annuler.click({ timeout: 10000 }).catch(() => {});
    log('[DRY_RUN] 已点 Annuler 关闭弹窗，未做任何续期');
  }
  await page.waitForTimeout(1000);
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const t0 = Date.now();
  if (!USER || !PASS) throw new Error('缺少 ACL_USERNAME / ACL_PASSWORD');
  if (DRY_RUN) log('DRY_RUN 模式：不真正续期');

  const execPath = resolveExecutablePath();
  // 本地代理：NODE_LINK 为空→直连；代理失败→回退直连（参考 hohai）
  const net = await setupProxy(log);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
    ...(execPath ? { executablePath: execPath } : {}),
    ...(net.proxyUrl ? { proxy: { server: net.proxyUrl } } : {}),
    // 可选：PW_CHANNEL=chromium 用新版 headless（更接近真实浏览器，验证码被拦时试试）
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: process.env.ACL_LOCALE || 'en-US',
    storageState: fs.existsSync(AUTH) ? AUTH : undefined,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  context.setDefaultTimeout(30000);
  context.setDefaultNavigationTimeout(45000);
  const page = await context.newPage();

  const results = [];
  let fatalError = '';
  try {
    await login(page, shot, { base: BASE, user: USER, pass: PASS, authPath: AUTH });
    await shot(page, '03-dashboard.png');

    let servers = await discover(page);
    if (SERVER_ID) servers = servers.filter((s) => s.id === SERVER_ID || s.uuid === SERVER_ID);
    if (!servers.length) throw new Error('未找到可续期服务');

    for (const server of servers) {
      const res = { server, outcome: 'failed', error: '', resources: { state: 'unknown', uptimeMs: null } };
      try {
        if (DRY_RUN) {
          await dryRunCheck(page, server);
          res.outcome = 'dryrun';
        } else {
          res.outcome = await tryRenew(page, server);
        }
      } catch (e) {
        res.outcome = 'failed';
        res.error = e.message;
        log(`[${server.name}] 失败: ${e.message}`);
        res.errShot = await shot(page, '99-error.png');
      }
      try {
        res.resources = await getResources(page, server.id);
      } catch { /* 忽略状态读取失败 */ }
      results.push(res);
    }
  } catch (e) {
    fatalError = e.message;
    log(`执行失败: ${e.message}`);
    try { await shot(page, '99-error.png'); } catch {}
  } finally {
    await browser.close().catch(() => {});
    await net.stop().catch(() => {});
  }

  const scriptSec = (Date.now() - t0) / 1000;
  const executedAt = beijingDateTime(new Date());

  if (fatalError && !results.length) {
    // 登录/发现阶段就挂了：发一条整体失败通知
    const msg = buildTgMessage({
      outcome: 'failed', server: {}, resources: { state: 'unknown', uptimeMs: null },
      scriptSec, executedAt, error: fatalError, net,
    });
    const errPic = path.join(SHOT, '99-error.png');
    await tg(msg, { photo: fs.existsSync(errPic) ? errPic : null });
    process.exit(1);
  }

  // 每台服务一条 TG（bot-hosting 风格模板）
  for (const r of results) {
    const msg = buildTgMessage({
      outcome: r.outcome, server: r.server, resources: r.resources,
      scriptSec, executedAt, error: r.error, net,
    });
    log(`TG 预览:\n${msg}`);
    await tg(msg, { photo: r.outcome === 'failed' && r.errShot ? r.errShot : null });
  }

  // unconfirmed 也算异常退出：Actions 页面标红，不然只能靠 TG 的 ❓ 发现
  if (results.some((r) => r.outcome === 'failed' || r.outcome === 'unconfirmed')) process.exit(1);
  log('全部完成');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(async (e) => {
    log(e.stack || e.message);
    process.exit(1);
  });
}
