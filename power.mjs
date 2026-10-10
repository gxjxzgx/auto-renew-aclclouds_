#!/usr/bin/env node
/**
 * ACLClouds 掉线检查 / 自动开机（独立于续期）
 * 复用登录会话 auth.json；每天跑，offline → power start
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { setupProxy } from './proxy_helper.mjs';
import {
  log,
  maskAccount,
  escapeHtml,
  createShot,
  tg,
  api,
  resolveExecutablePath,
  login,
} from './common.mjs';

const BASE = (process.env.ACL_BASE_URL || 'https://aclclouds.com').replace(
  /\/+$/,
  '',
);
const USER = process.env.ACL_USERNAME || process.env.ACL_EMAIL || '';
const PASS = process.env.ACL_PASSWORD || '';
const SERVER_ID = process.env.ACL_SERVER_ID || '';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const AUTH = path.resolve(process.env.ACL_AUTH_STATE || 'auth.json');
const SHOT = path.resolve('shots');
const POLL_SEC = 60;

const shot = createShot(SHOT);

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
        });
      }
    }
  }
  if (
    SERVER_ID &&
    !servers.some((s) => s.id === SERVER_ID || s.uuid === SERVER_ID)
  ) {
    servers.push({ id: SERVER_ID, uuid: SERVER_ID, name: SERVER_ID });
  }
  log(
    `发现服务: ${servers.map((s) => `${s.name}(${s.id})`).join(', ') || '(无)'}`,
  );
  return servers;
}

async function getState(page, id) {
  const r = await api(page, `/api/client/servers/${id}/resources`);
  if (r.status !== 200) {
    log(`resources HTTP ${r.status} for ${id}`);
    return 'unknown';
  }
  const state = (r.data?.attributes?.current_state || 'unknown').toLowerCase();
  return state;
}

async function powerStart(page, id) {
  if (DRY_RUN) {
    log(`[DRY_RUN] 跳过 power start ${id}`);
    return true;
  }
  const r = await api(page, `/api/client/servers/${id}/power`, 'POST', {
    signal: 'start',
  });
  // 204 / 200 均视为接受
  const ok = r.status === 204 || r.status === 200;
  log(
    `power start ${id}: HTTP ${r.status} ${ok ? 'OK' : JSON.stringify(r.data).slice(0, 120)}`,
  );
  return ok;
}

async function ensureRunning(page, server) {
  const { id, name } = server;
  const state = await getState(page, id);
  log(`[${name}] 状态: ${state}`);

  if (state === 'running') {
    return {
      id,
      name,
      ok: true,
      action: 'skip',
      text: `${name}: 运行中，跳过`,
    };
  }
  if (state === 'starting') {
    return {
      id,
      name,
      ok: true,
      action: 'wait',
      text: `${name}: 启动中，跳过`,
    };
  }

  // offline / stopping / unknown → 开机
  log(`[${name}] 尝试开机...`);
  const sent = await powerStart(page, id);
  if (!sent) {
    return {
      id,
      name,
      ok: false,
      action: 'start_fail',
      text: `${name}: 开机请求失败（可能已挂起，需先续期）`,
    };
  }

  let final = state;
  const deadline = Date.now() + POLL_SEC * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    final = await getState(page, id);
    log(`[${name}] 轮询状态: ${final}`);
    if (final === 'running') break;
  }

  if (final === 'running') {
    return { id, name, ok: true, action: 'started', text: `${name}: 开机成功` };
  }
  return {
    id,
    name,
    ok: false,
    action: 'timeout',
    text: `${name}: 已发开机，当前仍为 ${final}`,
  };
}

function formatTg({ failed, results, errorMsg }) {
  const beijing = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
  const anyStarted = results.some((r) => r.action === 'started');
  let title = '✅ <b></b>';
  if (failed) title = '❌ <b></b>';
  else if (anyStarted) title = '🔌 <b></b>';

  const lines = [
    title,
    '━━━━━━━━━━━━━━━━━━━━',
    `🕒 ${beijing} (北京时间)`,
    `👤 <code>${escapeHtml(maskAccount(USER))}</code>`,
    '━━━━━━━━━━━━━━━━━━━━',
  ];
  // errorMsg / 服务器名可能含 <div> 等（Playwright 超时报错常见），必须转义，
  // 否则 Telegram parse_mode=HTML 会回 400，最需要通知的失败反而发不出去
  if (errorMsg) lines.push(`⚠️ ${escapeHtml(errorMsg)}`);
  for (const r of results) {
    const icon = r.ok ? (r.action === 'started' ? '🔌' : '✅') : '❌';
    lines.push(`${icon} ${escapeHtml(r.text)}`);
  }
  return lines.join('\n');
}

async function main() {
  if (!USER || !PASS) throw new Error('缺少 ACL_USERNAME / ACL_PASSWORD');

  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
    ...(resolveExecutablePath()
      ? { executablePath: resolveExecutablePath() }
      : {}),
    // 可选：PW_CHANNEL=chromium 用新版 headless（更接近真实浏览器，验证码被拦时试试）
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  };

  // 本地代理：NODE_LINK 为空→直连；代理失败→回退直连（参考 hohai）
  const net = await setupProxy(log);
  if (net.proxyUrl) launchOptions.proxy = { server: net.proxyUrl };

  const browser = await chromium.launch(launchOptions);
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

  let failed = false;
  const results = [];
  let errorMsg = '';

  try {
    await login(page, shot, {
      base: BASE,
      user: USER,
      pass: PASS,
      authPath: AUTH,
    });
    const servers = await discover(page);
    if (!servers.length) {
      failed = true;
      errorMsg = '未发现任何服务器';
    } else {
      for (const s of servers) {
        if (SERVER_ID && s.id !== SERVER_ID && s.uuid !== SERVER_ID) continue;
        results.push(await ensureRunning(page, s));
      }
      failed = results.some((r) => !r.ok);
    }
  } catch (e) {
    failed = true;
    errorMsg = e.message;
    log(errorMsg);
    try {
      await shot(page, 'power-99-error.png');
    } catch {}
  } finally {
    await browser.close().catch(() => {});
    await net.stop().catch(() => {});
  }

  // 全是「运行中跳过」时可选择不刷 TG：仅当有开机动作或失败时通知
  const silentOk =
    !failed &&
    results.length > 0 &&
    results.every((r) => r.action === 'skip' || r.action === 'wait');
  const msg = formatTg({ failed, results, errorMsg });
  log(msg.replace(/<[^>]+>/g, ''));
  if (!silentOk) {
    await tg(msg, { parseMode: 'HTML' });
  } else {
    log('全部运行中，跳过 TG 通知');
  }

  if (failed) process.exit(1);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(async (e) => {
    log(e.stack || e.message);
    await tg(
      formatTg({
        failed: true,
        results: [],
        errorMsg: e.message,
      }),
      { parseMode: 'HTML' },
    );
    process.exit(1);
  });
}
