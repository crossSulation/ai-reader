#!/usr/bin/env node
/**
 * 端到端回归测试：真实 Chrome + **真实鼠标事件**（CDP Input.dispatchMouseEvent）
 *
 * 为什么需要它：静态检查能验证「模板里的 class 有没有样式」，但验证不了
 * 「用户点下去到底发生了什么」。合成事件（el.click()）也不会暴露
 * 「mousedown 里把自己藏起来 → click 根本不会派发到该元素」这类问题 —— 只有真实输入能。
 *
 * 用法：
 *   node tools/e2e.mjs          # 无头
 *   HEADED=1 node tools/e2e.mjs # 有头，便于肉眼观察
 *
 * 依赖：本机已安装 Chrome（不需要 Playwright）。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = pathToFileURL(path.join(HERE, 'harness.html')).href;
const PORT = Number(process.env.PORT || 9333);
const HEADED = !!process.env.HEADED;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 找 Chrome                                                          */
/* ------------------------------------------------------------------ */

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return 'chrome'; // 交给 PATH
}

/* ------------------------------------------------------------------ */
/* 极简 CDP 客户端                                                     */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.probeLogs = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        this.probeLogs.push(msg.params.args.map((a) => a.value).join(' '));
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 15000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`页面内求值失败：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      clickCount: 1,
      ...extra,
    });
  }

  /** 一次真实的按下-抬起（浏览器会自动派发 click） */
  async clickAt(x, y) {
    await this.mouse('mouseMoved', x, y, { button: 'none', buttons: 0 });
    await this.mouse('mousePressed', x, y, { buttons: 1 });
    await sleep(30);
    await this.mouse('mouseReleased', x, y, { buttons: 0 });
  }

  /** 拖选一段文字 */
  async dragSelect(from, to) {
    await this.mouse('mouseMoved', from.x, from.y, { button: 'none', buttons: 0 });
    await this.mouse('mousePressed', from.x, from.y, { buttons: 1 });
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await this.mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, {
        buttons: 1,
      });
      await sleep(12);
    }
    await this.mouse('mouseReleased', to.x, to.y, { buttons: 0 });
  }
}

/* ------------------------------------------------------------------ */
/* 被测 UI 的探针                                                      */
/* ------------------------------------------------------------------ */

const SNAPSHOT = `(() => {
  const out = {
    injected: !!window.__ARC_READER_INJECTED__,
    hasHost: false,
    // 诊断用：Element 上其实没有 composedPath（那是 Event 的方法）
    bodyHasComposedPath: typeof document.body.composedPath,
  };
  const h = document.querySelector('arc-reader-ui');
  if (!h) return out;
  out.hasHost = true;
  const sr = h.shadowRoot;
  const q = (s) => sr.querySelector(s);
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) }; };
  const chip = q('.chip');
  out.popHidden = q('.pop').hidden;
  out.popBox = box(q('.pop'));
  out.popQuote = (q('.pop-quote') || {}).textContent || '';
  out.chips = [...sr.querySelectorAll('.chip')].map((c) => c.textContent);
  out.chipBox = box(chip);
  out.chipLabel = chip ? chip.textContent : null;
  out.panelHidden = q('.panel').hidden;
  out.panelBox = box(q('.panel'));
  out.timelineMsgCount = sr.querySelectorAll('.timeline .msg').length;
  return out;
})()`;

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

async function main() {
  const chrome = findChrome();
  const profile = mkdtempSync(path.join(tmpdir(), 'arc-e2e-'));
  console.log(`Chrome: ${chrome}`);
  console.log(`测试页: ${HARNESS}\n`);

  const child = spawn(
    chrome,
    [
      HEADED ? '--new-window' : '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1280,900',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      HARNESS,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  let cdp;
  try {
    const page = await waitPort();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await sleep(400); // 等 content.js bootstrap 完成（storage 是异步的）

    console.log('【1】脚本注入与初始状态');
    let snap = await cdp.eval(SNAPSHOT);
    check('content.js 已执行', snap.injected);
    if (!snap.injected) throw new Error('脚本没跑起来，后续无从验证');
    check(
      '初始时没有创建任何 UI（宿主按需创建）',
      snap.hasHost === false,
      '理想情况是划词前页面上不留任何 DOM 痕迹'
    );
    check(
      `诊断：Element.composedPath 不存在（返回 "${snap.bodyHasComposedPath}"）`,
      snap.bodyHasComposedPath === 'undefined',
      '若这里不是 undefined，说明本环境 Element 上真有 composedPath，需重新判断根因'
    );

    console.log('\n【2】拖选正文 → 气泡是否浮出');
    const para = await cdp.eval(`(() => { const r = document.getElementById('para').getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
    await cdp.dragSelect(
      { x: para.left + 6, y: para.top + 10 },
      { x: para.right - 6, y: para.bottom - 10 }
    );
    await sleep(300);

    const selText = await cdp.eval('String(window.getSelection())');
    check('页面上确实有选区', selText.trim().length > 10, `选区内容：${JSON.stringify(selText.slice(0, 40))}`);
    snap = await cdp.eval(SNAPSHOT);
    check('划词后按需创建了宿主元素', snap.hasHost === true);
    check('划词后气泡浮出', snap.popHidden === false);
    check('气泡上渲染出动作按钮', (snap.chips || []).length > 0, `实际：${JSON.stringify(snap.chips)}`);

    console.log('\n【3】点击气泡上的动作 → 右侧面板是否弹出（本次 bug 的核心）');
    if (!snap.chipBox) {
      check('能取到动作按钮坐标', false, '气泡上没有按钮，跳过点击');
    } else {
      const chip = snap.chipBox;
      await cdp.clickAt(chip.x, chip.y);
      await sleep(400);

      snap = await cdp.eval(SNAPSHOT);
      check(
        `点击「${snap.chipLabel}」后气泡收起`,
        snap.popHidden === true,
        '气泡没收起，可能点击没被我们的 UI 处理'
      );
      check(
        '右侧对话面板弹出',
        snap.panelHidden === false,
        `panelHidden=${snap.panelHidden}（true = 面板没打开）`
      );
      check('面板里已经建出一条消息', snap.timelineMsgCount > 0, `msg 数=${snap.timelineMsgCount}`);
    }

    console.log('\n【4】提问是否真的发给了后台');
    const posted = await cdp.eval('window.__port.posted');
    check(
      '已向后台发出 1 条 ask 请求',
      posted.length === 1,
      `实际 ${posted.length} 条：${JSON.stringify(posted).slice(0, 160)}`
    );
    const req = posted[0];
    check(
      '请求带上了刚划的选区与所选动作',
      req?.type === 'ask' && req?.payload?.mode === 'explain' && (req?.payload?.selection || '').length > 10,
      `实际：mode=${req?.payload?.mode} selection=${JSON.stringify((req?.payload?.selection || '').slice(0, 30))}`
    );

    console.log('\n【5】同一段文字重新划选 → 气泡应能再次浮出');
    // 先点一下空白处让选区塌陷：直接在「已选中的文字上」拖拽会触发 Chrome 的原生拖放，
    // 那条路径不产生 mouseup，不是页面里真实的重新划词动作。
    await cdp.clickAt(para.left + 6, para.bottom + 40);
    await sleep(150);
    const collapsed = await cdp.eval('window.getSelection().isCollapsed');
    check('点击空白处后选区已塌陷', collapsed === true);

    await cdp.dragSelect(
      { x: para.left + 6, y: para.top + 10 },
      { x: para.right - 6, y: para.bottom - 10 }
    );
    await sleep(300);
    snap = await cdp.eval(SNAPSHOT);
    check(
      '重新划同一段文字后气泡仍会浮出',
      snap.popHidden === false,
      '气泡被收起后去重标记没复位，用户会感觉「划词没反应」'
    );

    console.log('\n【6】真实鼠标事件落点（页面探针）');
    const logs = await cdp.eval('window.__log');
    for (const line of logs) console.log(`      ${line}`);
    check(
      'click 事件确实落到了气泡里的动作按钮上',
      logs.some((l) => l.startsWith('click -> .chip')),
      '若 click 落在 #para / HTML 上，说明 mousedown 时按钮被隐藏，click 没能派发到它'
    );
  } finally {
    try {
      cdp?.ws.close();
    } catch {
      /* ignore */
    }
    child.kill();
    await sleep(200);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Windows 下偶发占用，忽略 */
    }
  }
}

main()
  .then(() => {
    console.log(`\n结果：${passed} 通过，${failed} 失败`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error(`\n运行失败：${err.message}`);
    console.log(`\n结果：${passed} 通过，${failed + 1} 失败`);
    process.exit(1);
  });
