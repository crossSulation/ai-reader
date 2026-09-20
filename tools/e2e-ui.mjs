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
  const qs = new URLSearchParams(location.search);
  const BASE = {
    preset: 'deepseek', protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: '',
    temperature: 0.3, trigger: 'chip', defaultMode: 'explain',
    selectedModes: ['explain', 'translate', 'example', 'deeper', 'ask'],
    autoSave: true, maxHistory: 800, disabledDomains: [],
    // language 默认 auto = 跟随浏览器；下面用 ?uilang= 显式覆盖来测两种渲染
    language: qs.get('uilang') || 'auto',
  };
  const state = qs.get('state') || 'unconfigured';
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
      case 'history:export': return { ok: true, markdown: '# 导出\\n' };
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
    // 浏览器界面语言：默认中文，用 ?lang=en-US 模拟英文浏览器
    i18n: { getUILanguage: () => qs.get('lang') || 'zh-CN' },
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

/**
 * 界面语言快照。
 *
 * 除了「是不是英文」，还要抓**残留的中文**：局部漏译（比如卡片标题换了、
 * 里面的提示文字没换）在肉眼看来「差不多能用」，只有整片扫描才抓得住。
 * 语言下拉里的「简体中文」是刻意的 endonym，选项里也必然有中文，所以排除掉。
 */
const LOCALE_SNAPSHOT = `(() => {
  const txt = (sel) => {
    const el = document.querySelector(sel);
    return el ? (el.textContent || '').trim() : null;
  };
  const panel = document.querySelector('#panel-general');
  let cjkCount = 0;
  let cjkSample = '';
  if (panel) {
    const clone = panel.cloneNode(true);
    // 这些位置的文案要么是 endonym，要么是动作名（两种语言都用同一个词），
    // 要么是 select 的 option —— 都会天然带中文，不算漏译
    for (const sel of ['#language', '#preset', '#protocol', '#defaultMode', '#quickAskMode', '#modeChecks']) {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    }
    const found = (clone.textContent.match(/[\\u4e00-\\u9fff]/g) || []);
    cjkCount = found.length;
    if (cjkCount) {
      const at = clone.textContent.search(/[\\u4e00-\\u9fff]/);
      cjkSample = clone.textContent.slice(Math.max(0, at - 30), at + 30).replace(/\\s+/g, ' ');
    }
  }
  return {
    tabSettings: txt('.tab[data-tab="general"]'),
    modelCardTitle: txt('#panel-general .card-head h2'),
    htmlLang: document.documentElement.lang,
    docTitle: document.title,
    languageValue: (document.querySelector('#language') || {}).value || null,
    cjkCount,
    cjkSample,
  };
})()`;

async function readLocaleSnapshot(cdp) {
  return cdp.eval(LOCALE_SNAPSHOT);
}

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
    check('脚手架脚本执行完成，不再是加载占位文案', !/加载中|Loading/.test(s.modelLine), `modelLine=${JSON.stringify(s.modelLine)}`);
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

    /* ---------------------------------------------------------------- */
    console.log('\n【7】options · 笔记集成卡片（导出的第二个入口）');

    const integrate = await cdp.eval(`(() => {
      const visible = (el) => {
        if (!el) return null;
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return st.display !== 'none' && st.visibility !== 'hidden' && r.height > 0;
      };
      const fields = {};
      for (const id of ['obsidianVault', 'obsidianFolder', 'notionToken', 'notionParentId']) {
        fields[id] = visible(document.getElementById(id));
      }
      return {
        fields,
        notionConnect: visible(document.getElementById('notionConnect')),
        obsidianTest: visible(document.getElementById('obsidianTest')),
        hint: (document.getElementById('integrateNote') || {}).textContent || '',
      };
    })()`);

    check(
      '四个集成输入框都在（库名 / 文件夹 / 令牌 / 父页面）',
      Object.values(integrate.fields).every((v) => v === true),
      JSON.stringify(integrate.fields)
    );
    check('「连接 Notion 并测试」按钮可见', integrate.notionConnect === true);
    check('「试写一篇 Obsidian 笔记」按钮可见', integrate.obsidianTest === true);
    check(
      '未配置时说明各需要什么',
      /Obsidian 无需授权/.test(integrate.hint),
      `文案：${JSON.stringify(integrate.hint)}`
    );

    // 父页面输入框：粘贴整条链接应当被归一化成裸 ID（否则 Notion API 直接 404）
    // 这张卡片在页面下方，先滚进视口才点得到
    await cdp.eval(`document.getElementById('notionParentId').scrollIntoView({ block: 'center' })`);
    await sleep(300);
    const parentBox = await cdp.eval(
      `(() => { const r = document.getElementById('notionParentId').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, inView: r.top > 0 && r.bottom < innerHeight }; })()`
    );
    check('父页面输入框已滚进视口（否则点击会落空）', parentBox.inView === true, `top=${parentBox.y}`);
    await cdp.clickAt(parentBox.x, parentBox.y);
    await sleep(120);
    await cdp.send('Input.insertText', {
      text: 'https://www.notion.so/team/Notes-1f2e3d4c5b6a7988776655443322110a?pvs=4',
    });
    await sleep(150);
    // 真实用户是失焦时触发 change
    await cdp.eval(
      `document.getElementById('notionParentId').dispatchEvent(new Event('change', { bubbles: true }))`
    );
    await sleep(400);
    const normalized = await cdp.eval(
      `document.getElementById('notionParentId').value`
    );
    check(
      '粘贴整条页面链接会被归一化成裸 ID',
      normalized === '1f2e3d4c5b6a7988776655443322110a',
      `实际：${JSON.stringify(normalized)} —— 带 URL 的 ID 会被 Notion 判 404`
    );

    /* ---------------------------------------------------------------- */
    console.log('\n【8】options · 历史面板的批量导出按钮');

    await cdp.eval(`document.querySelector('.tab[data-tab="history"]').click()`);
    await sleep(350);
    const histBtns = await cdp.eval(`(() => {
      const f = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { text: el.textContent, visible: st.display !== 'none' && r.height > 0 && r.width > 0 };
      };
      return { obsidian: f('exportObsidianBtn'), notion: f('exportNotionBtn'), md: f('exportBtn') };
    })()`);
    check('历史面板出现「发送到 Obsidian」', histBtns.obsidian?.visible === true);
    check('历史面板出现「发送到 Notion」', histBtns.notion?.visible === true);
    check('原来的「导出 Markdown」仍在', histBtns.md?.visible === true);

    /* ---------------------------------------------------------------- */
    console.log('\n【9】界面语言 · 自动检测浏览器语言');

    // 默认桩的浏览器语言是 zh-CN，且设置里 language='auto'
    const zhSnap = await readLocaleSnapshot(cdp);
    check('浏览器语言为中文时渲染中文', zhSnap.tabSettings === '设置', `实际：${zhSnap.tabSettings}`);
    check('<html lang> 同步成 zh-CN', zhSnap.htmlLang === 'zh-CN', `实际：${zhSnap.htmlLang}`);
    check('文档标题也是中文', zhSnap.docTitle.includes('设置'), `实际：${zhSnap.docTitle}`);
    check('中文界面里当然有中文（对照组）', zhSnap.cjkCount > 0, `CJK 字符数=${zhSnap.cjkCount}`);

    /* ---------------------------------------------------------------- */
    console.log('\n【10】界面语言 · 英文浏览器自动切英文');

    await cdp.navigate(page('options/options.html', 'configured') + '&lang=en-US');
    await sleep(420);
    const enSnap = await readLocaleSnapshot(cdp);
    check('同样的页面在英文浏览器下渲染英文', enSnap.tabSettings === 'Settings', `实际：${enSnap.tabSettings}`);
    check('<html lang> 切到 en', enSnap.htmlLang === 'en', `实际：${enSnap.htmlLang}`);
    check('卡片标题也切了（不是只换了一处）', enSnap.modelCardTitle === 'Model', `实际：${enSnap.modelCardTitle}`);
    check(
      '设置卡片里没有残留的中文（漏译会被这条抓住）',
      enSnap.cjkCount === 0,
      `残留：${enSnap.cjkSample}`
    );

    // 显式设置要能压过浏览器语言 —— 否则「浏览器是英文但我想用中文」就没法满足
    await cdp.navigate(page('options/options.html', 'configured') + '&lang=zh-CN&uilang=en');
    await sleep(420);
    const forced = await readLocaleSnapshot(cdp);
    check(
      '设置里显式选英文时，压过中文浏览器语言',
      forced.tabSettings === 'Settings',
      `实际：${forced.tabSettings}`
    );
    check('语言下拉停在用户选的那一项', forced.languageValue === 'en', `实际：${forced.languageValue}`);
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
