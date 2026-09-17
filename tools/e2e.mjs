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

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome, sleep } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = pathToFileURL(path.join(HERE, 'harness.html')).href;
const PORT = Number(process.env.PORT || 9333);
const HEADED = !!process.env.HEADED;

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
  out.bodyText = (q('.msg-body') || {}).textContent || '';

  // 分层回答的折叠区
  const moreBtn = q('.more-btn');
  out.more = moreBtn
    ? { label: moreBtn.textContent.trim(), expanded: moreBtn.getAttribute('aria-expanded'), box: box(moreBtn) }
    : null;
  const moreBody = q('.more-body');
  out.moreBodyHidden = moreBody ? moreBody.hidden : null;
  out.moreBodyText = moreBody ? moreBody.textContent.trim() : '';
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

async function main() {
  const { cdp, chromePath, close } = await launchChrome({ port: PORT, headed: HEADED, startUrl: HARNESS });
  console.log(`Chrome: ${chromePath}`);
  console.log(`测试页: ${HARNESS}\n`);

  try {
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

    /* ---------------------------------------------------------------- */

    console.log('\n【7】双击选词 → 直接提问（零动作路径）');
    await cdp.navigate(HARNESS);
    await sleep(400);

    const para2 = await cdp.eval(`(() => { const r = document.getElementById('para').getBoundingClientRect();
      return { left: r.left, top: r.top }; })()`);
    await cdp.doubleClickAt(para2.left + 20, para2.top + 10);
    await sleep(600); // 覆盖「等三击」的 180ms 窗口 + 一次渲染

    const word = await cdp.eval('String(window.getSelection())');
    check('双击确实选中了文本（浏览器原生选词）', word.trim().length > 0, `选中：${JSON.stringify(word)}`);

    snap = await cdp.eval(SNAPSHOT);
    check('双击时气泡完全不出现', snap.popHidden === true, '零动作路径不该再让用户点一次气泡');
    check('双击后右侧面板直接弹出', snap.panelHidden === false);

    const posted2 = await cdp.eval('window.__port.posted');
    check('双击已直接发起提问', posted2.length === 1, `实际 ${posted2.length} 条`);
    check(
      '用的是设置里「双击时用的动作」',
      posted2[0]?.payload?.mode === 'explain',
      `实际 mode=${posted2[0]?.payload?.mode}`
    );

    /* ---------------------------------------------------------------- */

    console.log('\n【8】分层回答：结论层先行，展开层默认折叠');
    const reqId = posted2[0]?.reqId;

    await cdp.eval(`(() => {
      const id = ${JSON.stringify(reqId)};
      window.__emit({ type: 'start', reqId: id, model: 'stub-model' });
      window.__emit({ type: 'delta', reqId: id, part: 'brief', text: '注意力机制是让模型按相关度分配权重。' });
    })()`);
    await sleep(200);

    snap = await cdp.eval(SNAPSHOT);
    check('结论层已渲染', snap.bodyText.includes('按相关度分配权重'));
    check('后端还没给出展开层时，不显示折叠按钮', snap.more === null, `实际：${JSON.stringify(snap.more)}`);

    await cdp.eval(`(() => {
      const id = ${JSON.stringify(reqId)};
      window.__emit({ type: 'delta', reqId: id, part: 'detail', text: '它最早来自机器翻译任务，' });
      window.__emit({ type: 'delta', reqId: id, part: 'detail', text: '后来成为大语言模型的基础组件。' });
    })()`);
    await sleep(200);

    snap = await cdp.eval(SNAPSHOT);
    check('出现「展开细节」按钮', !!snap.more, `实际：${JSON.stringify(snap.more)}`);
    check('展开层默认折叠', snap.moreBodyHidden === true, '默认展开就等于没分层');
    check(
      '折叠区里已有内容（流式期间就在填充，不必等生成完）',
      snap.moreBodyText.includes('机器翻译任务'),
      `实际：${JSON.stringify(snap.moreBodyText.slice(0, 40))}`
    );

    await cdp.clickAt(snap.more.box.x, snap.more.box.y);
    await sleep(200);
    snap = await cdp.eval(SNAPSHOT);
    check('点击后展开层显示出来', snap.moreBodyHidden === false);
    check('按钮文案切换为「收起细节」', snap.more.label.includes('收起细节'), `实际：${snap.more.label}`);
    check('展开状态写回 turn（aria-expanded=true）', snap.more.expanded === 'true');

    // 这条是折叠状态存在 turn 上而不是 DOM 上的理由：
    // 流式每来一段增量都会重写 innerHTML，状态若挂在 DOM 上就会被重置回折叠。
    await cdp.eval(`window.__emit({ type: 'delta', reqId: ${JSON.stringify(reqId)}, part: 'detail', text: '补一句。' })`);
    await sleep(200);
    snap = await cdp.eval(SNAPSHOT);
    check(
      '流式增量重绘后展开状态没丢',
      snap.moreBodyHidden === false && snap.more.expanded === 'true',
      '重新渲染后折叠回去了，说明状态存在 DOM 上'
    );

    await cdp.eval(`(() => {
      window.__emit({ type: 'done', reqId: ${JSON.stringify(reqId)},
        answer: '注意力机制是让模型按相关度分配权重。',
        detail: '它最早来自机器翻译任务，后来成为大语言模型的基础组件。补一句。',
        saved: true, recordId: 'stub-record', elapsed: 820, model: 'stub-model' });
    })()`);
    await sleep(200);
    snap = await cdp.eval(SNAPSHOT);
    check('完成后按钮提示改为字数', /字/.test(snap.more.label), `实际：${snap.more.label}`);
    check('完成后展开状态保持不变', snap.moreBodyHidden === false);

    /* ---------------------------------------------------------------- */

    console.log('\n【9】三击选中整段 → 不该走「双击即问」');
    await cdp.navigate(HARNESS);
    await sleep(400);
    const para3 = await cdp.eval(`(() => { const r = document.getElementById('para').getBoundingClientRect();
      return { left: r.left, top: r.top }; })()`);
    await cdp.tripleClickAt(para3.left + 20, para3.top + 10);
    await sleep(600);

    snap = await cdp.eval(SNAPSHOT);
    const posted3 = await cdp.eval('window.__port.posted');
    check(
      '三击没有直接发问',
      posted3.length === 0,
      `实际发了 ${posted3.length} 条 —— 双击即问把三击也吞掉了，用户就没法「选整段再挑动作」`
    );
    check('三击走常规流程：气泡浮出，动作由用户挑', snap.popHidden === false);
  } finally {
    await close();
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
