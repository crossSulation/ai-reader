/**
 * 极简 CDP 工具箱：启动本机 Chrome + 手写协议客户端。
 *
 * 刻意不引 Playwright：Node 22 已内置 fetch 与 WebSocket，
 * 而这里需要的东西很少（开页面、注入脚本、发真实鼠标事件），
 * 自己写反而更可控、更少依赖（`node tools/xxx.mjs` 直接就能跑）。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return 'chrome'; // 交给 PATH
}

/* ------------------------------------------------------------------ */
/* CDP 客户端                                                          */
/* ------------------------------------------------------------------ */

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.probeLogs = [];
    this.pageErrors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        this.probeLogs.push(msg.params.args.map((a) => a.value).join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.pageErrors.push(d.exception?.description || d.text);
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
      }, 20000);
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
      await this.mouse(
        'mouseMoved',
        from.x + ((to.x - from.x) * i) / steps,
        from.y + ((to.y - from.y) * i) / steps,
        { buttons: 1 }
      );
      await sleep(12);
    }
    await this.mouse('mouseReleased', to.x, to.y, { buttons: 0 });
  }

  /** 导航并等页面加载完（轮询 readyState，比监听事件更省事） */
  async navigate(url) {
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      try {
        const rs = await this.eval('document.readyState');
        if (rs === 'complete') return;
      } catch {
        /* 导航中上下文会被销毁，忽略 */
      }
    }
    throw new Error(`页面迟迟没有加载完：${url}`);
  }
}

/* ------------------------------------------------------------------ */
/* 静态服务                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * 用一个极小的静态服务器把目录挂到 http://127.0.0.1:<port>。
 *
 * 为什么不用 file://：Chrome 会以 CORS 为由拒绝从 file:// 加载 ES module，
 * 页面上的 <script type="module"> 直接不执行 —— 于是测的是「脚本没跑」而不是产品。
 * 走 http 才和扩展真实运行环境一致。
 */
export async function serveDir(rootDir) {
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.join(rootDir, path.normalize(rel).replace(/^([/\\])+/, ''));
      if (!file.startsWith(rootDir)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/* ------------------------------------------------------------------ */
/* 启动 / 关闭 Chrome                                                  */
/* ------------------------------------------------------------------ */

/**
 * 启动 Chrome 并连上第一个页面 target。
 * @returns {{ cdp: CDP, close: () => Promise<void>, chromePath: string }}
 */
export async function launchChrome({ port = 9333, headed = false, startUrl = 'about:blank', windowSize = '1280,900' } = {}) {
  const chromePath = findChrome();
  const profile = mkdtempSync(path.join(tmpdir(), 'arc-cdp-'));
  const child = spawn(
    chromePath,
    [
      headed ? '--new-window' : '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--window-size=${windowSize}`,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      startUrl,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  const page = await (async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await res.json();
        const hit = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (hit) return hit;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    throw new Error('Chrome 调试端口未就绪');
  })();

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });

  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  return {
    cdp,
    chromePath,
    async close() {
      try {
        cdp.ws.close();
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
    },
  };
}
