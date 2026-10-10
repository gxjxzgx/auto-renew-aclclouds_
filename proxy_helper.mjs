/**
 * 本地代理（参考 hohai 的 node_proxy.py）。
 *
 * 行为：
 * - NODE_LINK 为空 → 不启动代理，直接返回直连
 * - NODE_LINK 非空 → 起 python 子进程跑 proxy_bootstrap.py（sing-box 转本地代理）；
 *   代理启动/自检失败 → 打日志警告，回退直连（不抛错、不中断主流程）
 *
 * 用法：
 *   import { setupProxy } from './proxy_helper.mjs';
 *   const net = await setupProxy(log);          // main() 开头
 *   // chromium.launch({ ..., ...(net.proxyUrl ? { proxy: { server: net.proxyUrl } } : {}) })
 *   await net.stop();                            // finally 里
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const direct = (stop = async () => {}) => ({ proxyUrl: null, exitIp: null, mode: '直连', stop });

/** IP 脱敏：186.241.123.31 → 186.241.*.*（与 node_proxy.py 一致） */
function maskIp(ip) {
  const v4 = (ip || '').trim().split('.');
  if (v4.length === 4 && v4.every((p) => /^\d+$/.test(p))) return `${v4[0]}.${v4[1]}.*.*`;
  const v6 = (ip || '').trim().split(':');
  if (v6.length >= 3) return v6.slice(0, 3).join(':') + ':****';
  return '****';
}

/** 直连模式下探测出口 IP（best-effort，失败返回 null） */
async function probeDirectExitIp() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: ctrl.signal });
    clearTimeout(timer);
    const body = await r.text();
    const m = body.match(/ip=([^\s]+)/);
    return m ? maskIp(m[1]) : null;
  } catch {
    return null;
  }
}

export async function setupProxy(log) {
  const net = await _setup(log);
  // 直连时也尽量给出出口 IP（用于 TG 展示）
  if (net.mode === '直连' && !net.exitIp) {
    net.exitIp = await probeDirectExitIp();
  }
  return net;
}

async function _setup(log) {
  const nodeLink = (process.env.NODE_LINK || '').trim();
  if (!nodeLink) {
    log('未配置 NODE_LINK，直连');
    return direct();
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(process.env.PYTHON_BIN || 'python3',
      [path.join(here, 'proxy_bootstrap.py')],
      { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      log('代理启动超时(60s)，改用直连');
      child.kill('SIGKILL');
      finish(direct());
    }, 60000);

    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      const nl = out.indexOf('\n');
      if (nl < 0 || done) return;
      try {
        const info = JSON.parse(out.slice(0, nl));
        if (info.error) {
          log(`代理启动失败，改用直连: ${info.error}`);
          child.kill('SIGKILL');
          finish(direct());
        } else {
          log(`代理就绪(${info.mode || '代理'})，出口 IP: ${info.exit_ip || '未知'}`);
          finish({
            proxyUrl: info.proxy_url || null,
            exitIp: info.exit_ip || null,
            mode: info.mode || '代理',
            stop: async () => { child.kill('SIGTERM'); },
          });
        }
      } catch (e) {
        log(`代理启动输出解析失败，改用直连: ${e.message}`);
        child.kill('SIGKILL');
        finish(direct());
      }
    });
    child.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) log(`[proxy] ${line}`);
    });
    child.on('exit', (code) => {
      if (!done) {
        log(`代理进程异常退出(code=${code})，改用直连`);
        finish(direct());
      }
    });
    child.on('error', (e) => {
      if (!done) {
        log(`代理子进程启动失败，改用直连: ${e.message}`);
        finish(direct());
      }
    });
  });
}
