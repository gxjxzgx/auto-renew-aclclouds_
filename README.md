# ACLClouds Auto-Renew

ACLClouds Free Bot 托管自动续期。Free 套餐约 4 天到期，到期前 2 天开放续期。脚本用账号密码登录（Cap 人机验证），发现真实 server id，调用续期 API；API 被 403 captcha_required 拦截时复刻人工走「Confirmation anti-robot」弹窗。GitHub Actions 每两天跑一次，结果发 Telegram。

## 做什么

1. Playwright 打开 `/auth/login`，填 `ACL_USERNAME` / `ACL_PASSWORD`
2. 过登录页 **Cap** 人机验证（两种形态：明 DOM `div.captcha > div.captcha-trigger[role="button"]`，点击等 "Vérifié"；en-US 下为 checkbox 版 "Verify you're human" → "You're human"；旧版 `<cap-widget>` 保留兜底）
3. 登录进 dashboard，调 `/api/client` 发现真实 server id（含 `expires_at`）
4. `POST /api/client/servers/{id}/upgrade/renew`
   - `200` 续期成功（刷新到期时间）
   - `400 renewal_not_available` 未到窗口（按成功处理）
   - `403 captcha_required` → 走弹窗流程（下）
   - 其它状态当失败
5. 弹窗流程：`/server/{id}` 点横幅上的 **Renouveler** → **Confirmation anti-robot** 弹窗 → 解 `<cap-widget data-cap-api-endpoint="https://cap.aclclouds.com/...">`（三通道捕获 token：solve 事件 / 元素属性 / `input[name="cap-token"]` 的 property，并监听 error 事件拿真实失败原因；**真正可点击的是其 open shadow root 内的 `div.captcha-trigger[role="button"]`**，选择器漏了 `[role="button"]` 会点到空处）→ token 签发后站点**自动提交续费**（该弹窗没有确认按钮）→ 轮询 `/api/client` 确认 `expires_at` 后移（续期前没读到到期时间时照常走流程，结果标 `❓ 无法确认`）
6. 每台服务读 `/api/client/servers/{id}/resources` 拿运行状态 + uptime，按 bot-hosting 风格模板发 Telegram（见下）

## Telegram

每台服务一条，纯文本模板：

```
ACLClouds 续期通知

✅ 续期成功
👤 登录账户: g***o@gmail.com
🌐 出口IP: 186.241.*.*（代理）
📅 到期时间: 2026/10/12
⏱️ 续期时间: 24小时后
🖥️ 机器状态: 🟢 运行中
⏳ 运行时长: 18天17小时
🕒 脚本耗时: 46秒
⏱️ 执行时间: 2026-10-08 13:33:20
```

| 状态行 | 含义 |
|---|---|
| ✅ 续期成功 | 到期时间已后移 |
| ⏳ 未到续期窗口 | API 返回 renewal_not_available |
| 🧪 DRY_RUN 预览 | dry run 模式（未真正续期） |
| ❓ 续期结果无法确认 | 续期前没读到到期时间，照常走完流程但无法判定；退出码 1，Actions 标红 |
| ❌ 续期失败 | 附 ⚠️ 原因行 + 失败截图 |

- 👤 账号脱敏：`user@example.com` → `u***r@example.com`
- ⏱️ 续期时间：窗口 = 到期前 2 天；续期成功后显示下次窗口倒计时；未到窗口时另附一行 `ℹ️ 剩余时间: X`
- 🖥️ 机器状态：🟢 运行中 / 🔴 已停止 / 🟡 启动中·停止中 / ⚪ 未知
- ⏳ 运行时长：resources 接口 uptime；非运行中显示 —
- 🕒 脚本耗时：从启动到 TG 发送前的总耗时
- 成功/未到窗口只发文本；失败才附截图。登录、验证码过程不发 TG。本地仍会把全过程截图写到 `shots/`。

## GitHub Actions

`.github/workflows/aclclouds.yml`：续期 + 保活合并在一个工作流里，两个 job 按触发来源分流（行为与合并前一致）。

- 定时：续期每两天 UTC `23:28`（北京时间次日 07:28）；保活每天 UTC `02:00` / `14:00`（北京时间 10:00 / 22:00）
- 手动 **Run workflow** 可选 `task`（all / renew / power）和 `dry_run`
  - renew 的 dry_run：只做登录 + 发现 + 状态读取 + 弹窗选择器校验（打开弹窗后点 Annuler 关闭），不发 POST renew、不点确认按钮；TG 消息带 🧪 DRY_RUN 标记
  - power 的 dry_run：只检查不真正开机

Secrets：

| 名 | 用途 |
|---|---|
| `ACL_USERNAME` | 登录用户名 |
| `ACL_PASSWORD` | 密码 |
| `ACL_SERVER_ID` | 可选，指定 server id（如 `a84b721d`）；留空则处理发现的全部服务 |
| `NODE_LINK` | 可选，代理节点链接（vless/vmess/trojan/ss/socks5/http，参考 hohai）；为空则直连 |
| `SING_BOX_SHA256` | 可选，sing-box 二进制 sha256 强校验 |
| `TG_BOT_TOKEN` | Telegram bot token |
| `TG_CHAT_ID` | Telegram chat id |

## 本地代理（参考 hohai）

- `node_proxy.py`（从 hohai 原样搬运，纯标准库）：把 `NODE_LINK` 整理成固定格式 → sing-box 转成本地 `http://127.0.0.1:随机端口` 混合代理 → 自检出口 IP
- `proxy_bootstrap.py` + `proxy_helper.mjs`：node 主进程起 python 常驻子进程做代理，浏览器（Playwright）走该代理；TG 通知仍直连
- `NODE_LINK` 为空 → 不起代理，直接连
- 代理启动/自检失败 → 打日志警告，**自动回退直连**，不中断主流程
- 日志里会打印 `代理就绪(代理)，出口 IP: 186.241.*.*`（脱敏）或 `未配置 NODE_LINK，直连`
- TG 通知里带 `🌐 出口IP: 脱敏IP（代理/直连）` 一行，直连时也会尽力探测出口 IP

Variable（可选）：`ACL_BASE_URL`，默认 `https://aclclouds.com`

调试变量（Variables，可选，都不设即默认行为）：
- `PW_CHANNEL`：设为 `chromium` 则用新版 headless（更接近真实浏览器，验证码被拦时试试）
- `ACL_LOCALE`：浏览器语言，默认 `en-US`（站点验证码文案随语言变化）

运行记录保留：每个 job 末尾 `if: always()` 清理，仅保留最近 10 条（保活每天跑 2 次，3 条不够排查）。

## 代码结构

- `renew.mjs`：续期主流程
- `power.mjs`：保活/自动开机
- `common.mjs`：公共模块（日志、账号脱敏、HTML 转义、TG、截图、站点 API、登录、验证码），两边共用
- `proxy_helper.mjs` + `proxy_bootstrap.py` + `node_proxy.py`：本地代理（见上）

## 运维 / 可靠性

- **TG 通知**：带 15 秒超时，5xx / 429 / 网络错误自动重试 3 次（429 按 `retry_after`）；错误日志不含 bot token。
- **Playwright**：默认操作超时 30 秒、导航超时 45 秒，不会无限挂起。
- **失败排查**：任一步骤失败会把 `shots/` 上传为 Artifact（保留 3 天）。截图可能含账号页面，**仓库请保持私有**。
- **前置步骤失败兜底**：装依赖 / 下载 sing-box 等在脚本之前失败时，脚本没机会发 TG，工作流会用 curl 补发一条带运行链接的提醒。
- **CI**：`.github/workflows/ci.yml` 在 push / PR 时做语法检查 + 单元测试（`npm test`，无需安装 playwright）。
- **验证码诊断**：`login()` 里挂了 `attachDiagnostics`（控制台报错、请求失败、4xx/5xx、cap 域名请求都记环形日志），验证码失败时 `dumpCaptchaDiag` 把控件文本/HTML 和最近事件打到日志，方便排查卡住原因。
- **依赖更新**：`.github/dependabot.yml` 每周检查 GitHub Actions 与 npm 依赖。Playwright 已固定为精确版本 `1.49.1`。
- ⚠️ **GitHub 会在仓库 60 天无活动后自动停用定时工作流**（公开仓库尤其明显）。如果某天通知突然不再来，先去 Actions 页面看工作流是否被停用，手动 Enable 即可。
- 建议在本地执行一次 `npm install` 并提交生成的 `package-lock.json`，之后把工作流里的 `npm install` 改成 `npm ci`，保证依赖可复现。

## 本地跑

```bash
cp .env.example .env   # 填账号、TG
npm install
npx playwright install chromium
node with-env.cjs
```

`DRY_RUN=1` 只登录、发现服务、读状态、校验弹窗选择器，不真正续期。

## 已完成 / 待做

**已完成**

- 账号密码登录，不再依赖手动导出 session cookie
- **Cap 验证码**：登录页明 DOM（`div.captcha-trigger`，等 "Vérifié"；en-US checkbox 版等 "You're human"，注意与初始文案 "Verify you're human" 区分）；续费弹窗 `<cap-widget>` 三通道 token 捕获 + error 事件监听
- 自动发现真实 Pterodactyl server id
- 续期接口打通；窗口外返回 `renewal_not_available` 视为正常
- `403 captcha_required` 走 Confirmation anti-robot 弹窗复刻人工流程（Cap token 必须经浏览器实时验证签发，裸调 API 固定 403）
- Actions 定时 + Secrets / Variable；登录成功写入 `auth.json`，Actions cache 下次跳过验证码；失效则删掉重登
- TG 改为 bot-hosting 风格模板：到期时间 / 可续期时间 / 机器状态 / 运行时长 / 脚本耗时 / 执行时间
- 旧版图片 OCR 逻辑已删除（`tesseract.js` 依赖移除，`test_ocr.mjs` 删除）
- headless 反检测：隐藏 webdriver、固定 UA

**待做**

- 等窗口打开后看一次真实弹窗续期（Cap 求解 → 确认按钮文案 → 到期后移）的端到端日志
- 若 Cap instrumentation 拦截 headless，可改 `headless: false` 或换更强 stealth

---

## 掉线检查 / 自动开机（同一工作流的 power job）

`power.mjs`（工作流里的 `power` job）：与续期分离，每天检查服务器状态，离线则调用 Pterodactyl `power start`。

### 行为

1. 复用 `auth.json` 会话（与续期共用 cache）
2. `GET /api/client` 发现服务器
3. `GET .../resources` 读 `current_state`
4. `offline` / 非 running → `POST .../power` `{"signal":"start"}`，轮询最多 60 秒
5. Telegram：仅在「执行了开机」或失败时通知；全部运行中则静默

### 定时

- 保活 job：每天 UTC `02:00`、`14:00`（约北京 10:00 / 22:00）
- 可手动 **Run workflow** → `ACLClouds Auto` → `task` 选 `power`

### 本地

```bash
node power.mjs
# 或
npm run power
DRY_RUN=1 node power.mjs   # 只检查不真正开机
```

Secrets 与续期相同：`ACL_USERNAME` / `ACL_PASSWORD` / 可选 `ACL_SERVER_ID` / TG。
