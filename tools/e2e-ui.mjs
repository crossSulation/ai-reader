#!/usr/bin/env node
/**
 * 扩展页面（popup / options）的真实浏览器回归测试。
 *
 * 为什么需要它：这两页的毛病不会让脚本报错，只会「看起来不对」——
 * 比如 `[hidden]` 被 CSS 的 `display` 覆盖，元素就永远显示，
 * 任何静态检查都看不出来（HTML 里明明写着 hidden），非得真算一遍样式。
 *
 * 做法：启动真实 Chrome，用 CDP 在文档创建前注入一个 `chrome.*` 桩，
 * 然后直接加载真实的 popup.html / options.html 跑断言。
 * 桩通过 URL 上的 `?state=` 切换「未配置 / 已配置 / 后台不可达」三种场景。
 *
 * 用法：
 *   node tools/e2e-ui.mjs
 *   HEADED=1 node tools/e2e-ui.mjs   # 有头，肉眼观察
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, serveDir, sleep } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PORT || 9334);
const HEADED = !!process.env.HEADED;

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

/* ------------------------------------------------------------------ */
/* chrome.* 桩                                                        */
/* ------------------------------------------------------------------ */

/** 在文档创建前注入，模拟扩展环境；`?state=` 决定后台返回什么 */
const CHROME_STUB = `(() => {
  const BASE = {
    preset: 'deepseek', protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: '',
    temperature: 0.3, trigger: 'chip', defaultMode: 'explain',
    selectedModes: ['explain', 'translate', 'example', 'deeper', 'ask'],
    autoSave: true, maxHistory: 800, disabledDomains: [],
  };
  const state = new URLSearchParams(location.search).get('state') || 'unconfigured';
  const settings = state === 'configured'
    ? { ...BASE, apiKey: 'sk-stub-abcdefghijklmnop', model: 'deepseek-chat' }
    : { ...BASE };

  const records = state === 'configured'
    ? [{ id: 'r1', selection: '示例选中内容', mode: 'explain', domain: 'example.com',
         url: 'https://example.com/a', title: '示例页', ts: Date.now(), favorite: false }]
    : [];

  const handle = (msg) => {
    switch (msg && msg.type) {
      case 'settings:get':  return { ok: true, settings };
      case 'settings:save': Object.assign(settings, msg.patch || {}); return { ok: true, settings };
      case 'settings:test': return { ok: true, reply: '好', model: settings.model || 'deepseek-chat',
                                     endpoint: 'https://api.deepseek.com/v1/chat/completions', elapsed: 12 };
      case 'history:list':  return { ok: true, records };
      default:              return { ok: false, error: '未实现：' + (msg && msg.type) };
    }
  };

  const runtime = {
    lastError: undefined,
    getURL: (p) => p,
    openOptionsPage: () => {},
    onMessage: { addListener: () => {} },
    sendMessage: (msg) =>
      state === 'error'
        ? Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'))
        : Promise.resolve(handle(msg)),
  };

  const extra = {
    runtime,
    tabs: { create: () => {}, query: async () => [] },
    permissions: {
      contains: async () => true,
      request: async () => true,
      getAll: async () => ({ origins: ['https://api.deepseek.com/*'] }),
    },
    downloads: { download: async () => 1 },
  };

  const target = window.chrome || (window.chrome = {});
  for (const [k, v] of Object.entries(extra)) {
    try {
      Object.defineProperty(target, k, { value: v, configurable: true, writable: true });
    } catch {
      target[k] = v;
    }
  }
  window.__stubState = state;
})()`;

/* ------------------------------------------------------------------ */
/* 探针                                                               */
/* ------------------------------------------------------------------ */

/** 页面可见性快照：同时把「带 hidden 但没真隐藏」的元素揪出来 */
const PAGE_SNAPSHOT = `(() => {
  const vis = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      display: cs.display,
      visibility: cs.visibility,
      hidden: el.hidden === true,
      shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 1 && r.height > 1,
      text: (el.textContent || '').trim().slice(0, 60),
      box: { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height },
    };
  };

  // 不变量：凡当前带 hidden 属性的元素，必须真的不显示
  const liars = [];
  for (const el of document.querySelectorAll('[hidden]')) {
    const cs = getComputedStyle(el);
    if (cs.display !== 'none') {
      liars.push({
        tag: el.tagName.toLowerCase(),
        id: el.id,
        cls: el.className && String(el.className),
        display: cs.display,
        text: (el.textContent || '').trim().slice(0, 40),
      });
    }
  }

  return {
    stubState: window.__stubState,
    title: document.title,
    liars,
    tip: vis('#tip'),
    tipText: (document.querySelector('#tipText') || {}).textContent || '',
    modelLine: (document.querySelector('#modelLine') || {}).textContent || '',
    recentEmpty: vis('#recentEmpty'),
    saveBtn: vis('#saveBtn'),
    dirtyHint: vis('#dirtyHint'),
    testResult: vis('#testResult'),
    panelGeneral: vis('#panel-general'),
    panelHistory: vis('#panel-history'),
    apiKeyFilled: ((document.querySelector('#apiKey') || {}).value || '').length > 0,
  };
})()`;

/* ------------------------------------------------------------------ */
/* 主流程                                                             */
/* ------------------------------------------------------------------ */

async function main() {
  const server = await serveDir(ROOT);
  const page = (rel, state) => `${server.base}/${rel}${state ? `?state=${state}` : ''}`;
  const { cdp, chromePath, close } = await launchChrome({ port: PORT, headed: HEADED });
  console.log(`Chrome: ${chromePath}`);
  console.log(`本地服务: ${server.base}\n`);

  try {
    // 每个新文档都先装桩，页面脚本才拿得到 chrome.*
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CHROME_STUB });

    /* ---------------------------------------------------------------- */
    console.log('【1】popup · 未配置时应当提示去配置');
    await cdp.navigate(page('popup/popup.html', 'unconfigured'));
    await sleep(400);
    let s = await cdp.eval(PAGE_SNAPSHOT);
    check('桩已生效（页面真的跑在模拟环境里）', s.stubState === 'unconfigured', `stubState=${s.stubState}`);
    check('脚手架脚本执行完成，不再是「加载中…」', s.modelLine !== '加载中…', `modelLine=${JSON.stringify(s.modelLine)}`);
    check('提示条可见', s.tip?.shown === true, `display=${s.tip?.display}`);
    check('提示条说明了缺什么', /API Key|接口地址|模型/.test(s.tipText), `文案：${JSON.stringify(s.tipText)}`);

    /* ---------------------------------------------------------------- */
    console.log('\n【2】popup · 配好 Key 后提示条必须消失（本次 bug 的核心）');
    await cdp.navigate(page('popup/popup.html', 'configured'));
    await sleep(400);
    s = await cdp.eval(PAGE_SNAPSHOT);
    check('桩切换到了「已配置」场景', s.stubState === 'configured', `stubState=${s.stubState}`);
    check('标题行显示模型名', /deepseek-chat/.test(s.modelLine), `modelLine=${JSON.stringify(s.modelLine)}`);
    check(
      '提示条被真正隐藏（display:none）',
      s.tip?.display === 'none',
      `display=${s.tip?.display} —— 带 hidden 的元素若仍占位，说明 CSS 的 display 覆盖了 [hidden]`
    );
    check('提示条不再占位（尺寸为 0）', s.tip?.shown === false, `w=${s.tip?.box?.w} h=${s.tip?.box?.h}`);

    /* ---------------------------------------------------------------- */
    console.log('\n【3】popup · 读不到设置时要说真话，不能假装「未配置」');
    await cdp.navigate(page('popup/popup.html', 'error'));
    await sleep(400);
    s = await cdp.eval(PAGE_SNAPSHOT);
    check('提示读取失败，而不是「加载中…」', /失败|无法/.test(s.modelLine), `modelLine=${JSON.stringify(s.modelLine)}`);

    /* ---------------------------------------------------------------- */
    console.log('\n【4】通用不变量：带 hidden 属性的元素必须真的不显示');
    // popup 取「已配置」态：此时 #tip 身上才真带着 hidden 属性，不变量才查得有意义
    for (const [label, url] of [
      ['popup(已配置)', page('popup/popup.html', 'configured')],
      ['popup(未配置)', page('popup/popup.html', 'unconfigured')],
      ['options', page('options/options.html')],
    ]) {
      await cdp.navigate(url);
      await sleep(500);
      const snap = await cdp.eval(PAGE_SNAPSHOT);
      check(
        `${label} 页没有「写着 hidden 却还在占位」的元素`,
        snap.liars.length === 0,
        snap.liars.length
          ? snap.liars
              .map((l) => `<${l.tag} id=${l.id} class="${l.cls}"> display=${l.display} 文案=${JSON.stringify(l.text)}`)
              .join('\n      ')
          : ''
      );
    }

    /* ---------------------------------------------------------------- */
    console.log('\n【5】options · 「改了但没保存」必须看得见');
    await cdp.navigate(page('options/options.html'));
    await sleep(600);
    s = await cdp.eval(PAGE_SNAPSHOT);
    check('选项页初始可用', s.saveBtn?.shown === true);
    check('初始没有未保存提示', s.dirtyHint?.shown === false, `display=${s.dirtyHint?.display}`);
    check('默认标签页是「设置」，历史面板隐藏', s.panelGeneral?.shown === true && s.panelHistory?.shown === false);

    // 真实输入：点进输入框，用 IME 插入文本
    const keyBox = await cdp.eval(
      `(() => { const r = document.querySelector('#apiKey').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
    );
    await cdp.clickAt(keyBox.x, keyBox.y);
    await sleep(120);
    await cdp.send('Input.insertText', { text: 'sk-typed-by-test-123456' });
    await sleep(200);
    s = await cdp.eval(PAGE_SNAPSHOT);
    check('输入框确实收到了文本', s.apiKeyFilled === true);
    check(
      '出现「未保存」提示',
      s.dirtyHint?.shown === true,
      '没有这个提示，用户会以为「填了就等于配好了」，然后奇怪为什么弹窗还说没配'
    );

    console.log('\n【6】options · 保存后提示消失');
    await cdp.clickAt(s.saveBtn.box.x, s.saveBtn.box.y);
    await sleep(900);
    s = await cdp.eval(PAGE_SNAPSHOT);
    check('测试结果区出现', s.testResult?.shown === true, `display=${s.testResult?.display}`);
    check('保存后未保存提示消失', s.dirtyHint?.shown === false);
  } finally {
    await close();
    await server.close();
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
