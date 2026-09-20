/**
 * 设置页
 *
 * 一个刻意的设计：「保存并测试」是**一个**动作，不是两个。
 * 因为「测试通过」和「实际使用时失败」同时为真的经典成因，
 * 就是测试读表单值、而真正干活读持久化值。先保存再测试，两者永远一致。
 */

import { PRESETS, originPatternOf } from '../lib/llm.js';
import { MODES } from '../lib/prompts.js';
import { DEFAULT_SETTINGS } from '../lib/store.js';
import {
  normalizeNotionId,
  looksLikeNotionId,
  obsidianUri,
  obsidianFilePath,
  sanitizeName,
} from '../lib/exporters.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const send = (msg) => chrome.runtime.sendMessage(msg);

let currentSettings = { ...DEFAULT_SETTINGS };
let allRecords = [];
let historyFiltered = [];
let searchTimer = null;

/* ================================================================
 * 通用
 * ================================================================ */

function toast(text, ms = 2000) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => {
      el.hidden = true;
    }, 200);
  }, ms);
}

function escapeHtml(input) {
  return String(input == null ? '' : input).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/* ================================================================
 * Tab 切换
 * ================================================================ */

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab.dataset.tab}`));
    if (tab.dataset.tab === 'history') loadHistory();
  });
});

/* ================================================================
 * 表单
 * ================================================================ */

function fillPresetOptions() {
  const sel = $('#preset');
  sel.innerHTML = '';
  for (const p of PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = '自定义 / 其他服务商';
  sel.appendChild(custom);
}

function fillModeOptions() {
  const sel = $('#defaultMode');
  const quick = $('#quickAskMode');
  sel.innerHTML = '';
  quick.innerHTML = '';
  const checks = $('#modeChecks');
  checks.innerHTML = '';

  for (const [key, def] of Object.entries(MODES)) {
    if (key === 'ask') continue; // 追问要先有用户的问题，不能当默认动作或双击动作

    for (const target of [sel, quick]) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = def.label;
      target.appendChild(opt);
    }

    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" value="${key}"><span>${escapeHtml(def.label)}</span>`;
    checks.appendChild(label);
    label.querySelector('input').addEventListener('change', updateModeCheckHint);
  }
}

let updateModeCheckHint = () => {};

function readForm() {
  const modes = $$('#modeChecks input:checked').map((i) => i.value);
  if (!modes.includes('ask')) modes.push('ask'); // 追问必须保留，否则没法多轮

  return {
    preset: $('#preset').value,
    protocol: $('#protocol').value,
    baseUrl: $('#baseUrl').value.trim(),
    apiKey: $('#apiKey').value.trim(),
    model: $('#model').value.trim(),
    temperature: Number($('#temperature').value),
    contextBudget: Number($('#contextBudget').value),
    trigger: ($$('#triggerRadios input:checked')[0] || {}).value || 'chip',
    defaultMode: $('#defaultMode').value || 'explain',
    dblclickAsk: $('#dblclickAsk').checked,
    quickAskMode: $('#quickAskMode').value || 'explain',
    layered: $('#layered').checked,
    selectedModes: modes,
    autoSave: $('#autoSave').checked,
    maxHistory: Number($('#maxHistory').value),
    // 笔记集成：粘贴链接也认，入库前统一成裸 ID
    obsidianVault: $('#obsidianVault').value.trim(),
    obsidianFolder: $('#obsidianFolder').value.trim(),
    notionToken: $('#notionToken').value.trim(),
    notionParentId: normalizeNotionId($('#notionParentId').value),
    configured: !!( $('#baseUrl').value.trim() && $('#apiKey').value.trim() && $('#model').value.trim()),
  };
}

function fillForm(s) {
  currentSettings = { ...DEFAULT_SETTINGS, ...s };

  const preset = PRESETS.find((p) => p.id === currentSettings.preset);
  $('#preset').value = preset ? preset.id : 'custom';
  $('#protocol').value = currentSettings.protocol || 'openai';
  $('#baseUrl').value = currentSettings.baseUrl || '';
  $('#apiKey').value = currentSettings.apiKey || '';
  $('#model').value = currentSettings.model || '';
  $('#temperature').value = String(currentSettings.temperature ?? 0.3);
  $('#tempValue').textContent = String(currentSettings.temperature ?? 0.3);

  const budget = Number(currentSettings.contextBudget ?? 30000) || 30000;
  $('#contextBudget').value = String(budget);
  $('#contextBudgetValue').textContent = String(budget);

  const trigger = currentSettings.trigger || 'chip';
  $$('#triggerRadios input').forEach((r) => {
    r.checked = r.value === trigger;
  });

  $('#defaultMode').value = currentSettings.defaultMode || 'explain';

  $('#dblclickAsk').checked = currentSettings.dblclickAsk !== false;
  $('#quickAskMode').value = currentSettings.quickAskMode || 'explain';
  $('#layered').checked = currentSettings.layered !== false;

  const enabled = new Set(currentSettings.selectedModes || DEFAULT_SETTINGS.selectedModes);
  $$('#modeChecks input').forEach((i) => {
    i.checked = enabled.has(i.value);
  });

  $('#autoSave').checked = !!currentSettings.autoSave;
  $('#maxHistory').value = String(currentSettings.maxHistory ?? 800);
  $('#maxHistoryValue').textContent = String(currentSettings.maxHistory ?? 800);

  $('#obsidianVault').value = currentSettings.obsidianVault || '';
  $('#obsidianFolder').value = currentSettings.obsidianFolder || '';
  $('#notionToken').value = currentSettings.notionToken || '';
  $('#notionParentId').value = currentSettings.notionParentId || '';
  renderIntegrateHint();

  $('#keyHint').textContent = currentSettings.apiKey
    ? '密钥以明文保存在本机扩展存储中。建议单独申请一个低额度 Key 专供本插件使用。'
    : '还没有填密钥。密钥只存在本机，不会同步到其他设备。';

  // 表单已与存储对齐，此刻没有未保存的改动
  markSaved();
}

/* ================================================================
 * 「改动未保存」检测
 *
 * 存在的理由：「仅测试」只用表单值发请求、不写存储。用户看到测试通过，
 * 很自然地以为配置生效了，接着就会发现扩展弹窗说「还没有配置模型」。
 * 把「未保存」显示出来，这类困惑就不会发生。
 * ================================================================ */

let savedCore = '';

function coreOfForm() {
  return JSON.stringify({
    protocol: $('#protocol').value,
    baseUrl: $('#baseUrl').value.trim(),
    apiKey: $('#apiKey').value.trim(),
    model: $('#model').value.trim(),
    temperature: Number($('#temperature').value),
  });
}

function renderDirty() {
  const dirty = coreOfForm() !== savedCore;
  $('#dirtyHint').hidden = !dirty;
  $('#saveBtn').classList.toggle('dirty', dirty);
  return dirty;
}

function markSaved() {
  savedCore = coreOfForm();
  renderDirty();
}

/** 表单值与预设对不上时，把下拉切到「自定义」 */
function syncPresetFromForm() {
  const baseUrl = $('#baseUrl').value.trim().replace(/\/+$/, '');
  const model = $('#model').value.trim();
  const protocol = $('#protocol').value;
  const hit = PRESETS.find(
    (p) => p.baseUrl.replace(/\/+$/, '') === baseUrl && p.model === model && p.protocol === protocol
  );
  $('#preset').value = hit ? hit.id : 'custom';
}

/* ================================================================
 * 事件
 * ================================================================ */

function bindForm() {
  $('#preset').addEventListener('change', () => {
    const p = PRESETS.find((x) => x.id === $('#preset').value);
    if (!p) return;
    $('#protocol').value = p.protocol;
    $('#baseUrl').value = p.baseUrl;
    $('#model').value = p.model;
    renderDirty();
    if (!currentSettings.apiKey) $('#apiKey').focus();
  });

  for (const id of ['#baseUrl', '#model', '#protocol']) {
    $(id).addEventListener('input', () => {
      syncPresetFromForm();
      renderDirty();
    });
    $(id).addEventListener('change', () => {
      syncPresetFromForm();
      renderDirty();
    });
  }

  // 密钥和随机性也会影响「能否用起来」，同样纳入未保存检测
  $('#apiKey').addEventListener('input', renderDirty);
  $('#temperature').addEventListener('input', renderDirty);

  // 填了没保存就关页面，是最容易白费功夫的路径，拦一下
  window.addEventListener('beforeunload', (e) => {
    if (coreOfForm() === savedCore) return;
    e.preventDefault();
    e.returnValue = '';
  });

  $('#toggleKey').addEventListener('click', () => {
    const input = $('#apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#toggleKey').textContent = show ? '隐藏' : '显示';
  });

  $('#temperature').addEventListener('input', (e) => {
    $('#tempValue').textContent = e.target.value;
  });

  $('#contextBudget').addEventListener('input', (e) => {
    $('#contextBudgetValue').textContent = e.target.value;
  });

  $('#maxHistory').addEventListener('input', (e) => {
    $('#maxHistoryValue').textContent = e.target.value;
  });

  // 勾选变化立即生效（这两个属于交互偏好，不需要走「保存并测试」）
  $$('#triggerRadios input').forEach((r) => {
    r.addEventListener('change', () => persistQuiet({ trigger: r.value }));
  });
  $('#defaultMode').addEventListener('change', (e) => persistQuiet({ defaultMode: e.target.value }));
  $('#dblclickAsk').addEventListener('change', (e) => persistQuiet({ dblclickAsk: e.target.checked }));
  $('#quickAskMode').addEventListener('change', (e) => persistQuiet({ quickAskMode: e.target.value }));
  $('#layered').addEventListener('change', (e) => persistQuiet({ layered: e.target.checked }));
  $('#autoSave').addEventListener('change', (e) => persistQuiet({ autoSave: e.target.checked }));
  $('#maxHistory').addEventListener('change', (e) => persistQuiet({ maxHistory: Number(e.target.value) }));

  // 笔记集成：改完就存，不用等「保存并测试」——它跟模型接入是两码事
  for (const id of ['obsidianVault', 'obsidianFolder', 'notionToken', 'notionParentId']) {
    $(`#${id}`).addEventListener('change', (e) => {
      const value = id === 'notionParentId' ? normalizeNotionId(e.target.value) : e.target.value.trim();
      if (id === 'notionParentId' && value) e.target.value = value;
      persistQuiet({ [id]: value });
      renderIntegrateHint();
    });
  }
  $('#notionConnect').addEventListener('click', onNotionConnect);
  $('#obsidianTest').addEventListener('click', onObsidianTest);
  $('#contextBudget').addEventListener('change', (e) => persistQuiet({ contextBudget: Number(e.target.value) }));
  $('#modeChecks').addEventListener('change', () => {
    const modes = $$('#modeChecks input:checked').map((i) => i.value);
    if (!modes.includes('ask')) modes.push('ask');
    persistQuiet({ selectedModes: modes });
  });

  $('#saveBtn').addEventListener('click', onSaveAndTest);
  $('#testOnlyBtn').addEventListener('click', () => runTest({ useForm: true }));
  $('#refreshPerm').addEventListener('click', () => {
    renderPermissions();
    toast('已刷新权限列表');
  });

  $('#search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderHistory, 160);
  });
  $('#domainFilter').addEventListener('change', renderHistory);
  $('#onlyStar').addEventListener('change', renderHistory);
  $('#exportBtn').addEventListener('click', onExport);
  $('#clearBtn').addEventListener('click', onClear);
}

async function persistQuiet(patch) {
  Object.assign(currentSettings, patch);
  const res = await send({ type: 'settings:save', patch });
  if (!res?.ok) toast(`保存失败：${res?.error || '未知错误'}`, 3200);
}

/* ================================================================
 * 权限
 * ================================================================ */

/**
 * 申请接口域名权限。
 * 必须由用户手势直接触发（chrome.permissions.request 的硬性要求），
 * 所以调用点只能是按钮 click 回调的第一行。
 */
async function ensurePermission(baseUrl) {
  const pattern = originPatternOf(baseUrl);
  if (!pattern) {
    return { ok: false, message: '接口地址无法解析。请填写完整地址，例如 https://api.deepseek.com/v1' };
  }
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return { ok: true, pattern };
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (granted) return { ok: true, pattern, fresh: true };
    return {
      ok: false,
      message: `未获得 ${pattern} 的联网权限，请求会被浏览器拦截。请再点一次「保存并测试」，或在扩展详情页手动授予站点访问权限。`,
    };
  } catch (err) {
    return { ok: false, message: `申请权限失败：${err?.message || err}` };
  }
}

async function renderPermissions() {
  const box = $('#permList');
  let origins = [];
  try {
    const all = await chrome.permissions.getAll();
    origins = (all.origins || []).filter(Boolean);
  } catch {
    /* ignore */
  }

  // 全站通配符是 manifest 里的可选权限，不算已授予，过滤掉噪音
  const real = origins.filter((o) => !/^https?:\/\/(\*|https?)\/\*$/.test(o) && o !== '<all_urls>');

  if (!real.length) {
    box.innerHTML = '<div class="perm-empty">尚未授予任何接口域名的访问权限。填好模型配置后点「保存并测试」即可授权。</div>';
    return;
  }
  box.innerHTML = real
    .map((o) => `<div class="perm-item"><span class="pill">已授权</span>${escapeHtml(o)}</div>`)
    .join('');
}

/* ================================================================
 * 笔记集成（Obsidian / Notion）
 * ================================================================ */

const NOTION_ORIGIN = 'https://api.notion.com/*';

function renderIntegrateHint() {
  const note = $('#integrateNote');
  if (!note) return;
  const hasToken = !!$('#notionToken').value.trim();
  const hasParent = looksLikeNotionId($('#notionParentId').value);
  if (hasToken && hasParent) {
    note.textContent = 'Notion 已填写。点「连接 Notion 并测试」验证令牌和页面权限。';
  } else if (hasToken || hasParent) {
    note.textContent = '令牌与父页面都填好之后才能导出到 Notion。';
  } else {
    note.textContent = 'Obsidian 无需授权，填好库名就能用；Notion 需要上面两项配置。';
  }
}

/**
 * 连接 Notion：申请域名权限 → 校验令牌 → 校验父页面。
 *
 * chrome.permissions.request 必须吃用户手势，所以它是这个回调里**第一个** await ——
 * 先 await 别的东西（哪怕只是 contains 查询）都会让手势失效，弹窗就不会出现。
 */
async function onNotionConnect() {
  const btn = $('#notionConnect');
  const note = $('#integrateNote');

  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [NOTION_ORIGIN] });
  } catch (err) {
    note.textContent = `申请权限失败：${err?.message || err}`;
    return;
  }
  if (!granted) {
    note.textContent = '未授予 api.notion.com 的访问权限，导出到 Notion 会被浏览器拦下。';
    return;
  }

  const token = $('#notionToken').value.trim();
  const parent = normalizeNotionId($('#notionParentId').value);
  if (!token) {
    note.textContent = '先填写 Notion 集成令牌。';
    return;
  }
  $('#notionParentId').value = parent;
  await persistQuiet({ notionToken: token, notionParentId: parent });

  btn.disabled = true;
  btn.textContent = '连接中…';
  try {
    const res = await send({ type: 'export:test-notion', token, parentId: parent });
    note.textContent = res?.ok
      ? `连接正常：集成「${res.botName}」· 父页面「${res.parentTitle}」已就绪。`
      : `连接失败：${res?.error || '未知错误'}`;
    await renderPermissions();
  } catch (err) {
    note.textContent = `连接失败：${err?.message || err}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '连接 Notion 并测试';
  }
}

/** 往 Obsidian 写一篇测试笔记，用来确认库名/文件夹填对了 */
async function onObsidianTest() {
  const note = $('#integrateNote');
  const vault = $('#obsidianVault').value.trim();
  const folder = $('#obsidianFolder').value.trim();
  const name = sanitizeName('AI 阅读助手 · 配置测试', 60);
  const content = [
    '# 配置测试',
    '',
    '能看到这篇笔记，说明 Obsidian 这条链路是通的。',
    '',
    `库名：${vault || '(最近打开的库)'}`,
    `文件夹：${folder || '(库根目录)'}`,
    '',
  ].join('\n');

  try {
    await chrome.tabs.create({
      url: obsidianUri({ vault, file: obsidianFilePath(folder, name), content }),
    });
    note.textContent = '已发往 Obsidian，去库里看一眼有没有出现这篇测试笔记。';
  } catch (err) {
    note.textContent = `打开 Obsidian 失败：${err?.message || err}`;
  }
}

/**
 * 批量推送历史记录。
 * 一次导出合并成一篇笔记 / 一个 Notion 页面 —— 逐条建笔记会让库瞬间被灌满，
 * 而且几百次协议调用也不现实。
 */
async function pushBatchTo(target) {
  const rows = historyFiltered.length ? historyFiltered : allRecords;
  if (!rows.length) {
    toast('没有可导出的记录');
    return;
  }
  if (target === 'obsidian' && rows.length > 10) {
    const ok = confirm(
      `将把当前 ${rows.length} 条记录合并成一篇笔记写入 Obsidian。\n\n内容较长时会自动分成几次写入（每段都进同一篇笔记）。继续？`
    );
    if (!ok) return;
  }

  const btn = target === 'obsidian' ? $('#exportObsidianBtn') : $('#exportNotionBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    const res = await send({ type: 'export:save', target, records: rows });
    if (!res?.ok) {
      toast(res?.error || '发送失败', 4200);
      return;
    }
    if (target === 'obsidian') {
      toast(`已写入 Obsidian：${res.file}${res.chunks > 1 ? `（分 ${res.chunks} 段）` : ''}`, 3600);
    } else {
      toast(`已在 Notion 新建页面，写入 ${rows.length} 条记录`, 3600);
    }
  } catch (err) {
    toast(`发送失败：${err?.message || err}`, 4200);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ================================================================
 * 保存 / 测试
 * ================================================================ */

async function onSaveAndTest() {
  const btn = $('#saveBtn');
  btn.disabled = true;
  btn.textContent = '保存中…';

  try {
    const patch = readForm();

    // 顺序很重要：权限申请必须发生在用户手势的调用栈内
    const perm = await ensurePermission(patch.baseUrl);

    const saved = await send({ type: 'settings:save', patch });
    if (!saved?.ok) throw new Error(saved?.error || '保存失败');
    currentSettings = saved.settings;
    markSaved(); // 已落盘，未保存提示随之消失

    if (!perm.ok) {
      showResult('err', perm.message);
      return;
    }

    btn.textContent = '测试中…';
    await renderPermissions();
    // 不传 config：让 SW 读刚保存的持久化设置，测试路径 === 执行路径
    await runTest({ useForm: false });
  } catch (err) {
    showResult('err', String(err?.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = '保存并测试连接';
  }
}

async function runTest({ useForm }) {
  const box = $('#testResult');
  box.hidden = false;
  box.className = 'result loading';
  box.textContent = '正在向模型服务发起一次极短请求…';

  const config = useForm ? readForm() : undefined;
  const res = await send({ type: 'settings:test', config });

  if (res?.ok) {
    box.className = 'result ok';
    box.innerHTML =
      `<b>✓ 连接正常</b>\n` +
      `接口：${escapeHtml(res.endpoint)}\n` +
      `模型：${escapeHtml(res.model)}　·　耗时 ${res.elapsed}ms\n` +
      `模型回复：${escapeHtml(res.reply || '(空)')}` +
      (useForm
        ? `\n\n⚠ 本次测试用的是<b>表单当前值</b>，尚未保存。请点「保存并测试连接」让配置真正生效。`
        : '');
  } else {
    box.className = 'result err';
    box.innerHTML = `<b>✗ 连接失败</b>\n${escapeHtml(res?.error || '未知错误')}`;
  }
}

function showResult(kind, text) {
  const box = $('#testResult');
  box.hidden = false;
  box.className = `result ${kind}`;
  box.textContent = text;
}

/* ================================================================
 * 历史
 * ================================================================ */

async function loadHistory() {
  const res = await send({ type: 'history:list' });
  allRecords = res?.records || [];
  $('#histCount').textContent = String(allRecords.length);

  const domains = Array.from(new Set(allRecords.map((r) => r.domain).filter(Boolean))).sort();
  const sel = $('#domainFilter');
  const prev = sel.value;
  sel.innerHTML = '<option value="">全部来源</option>';
  for (const d of domains) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    sel.appendChild(opt);
  }
  if (domains.includes(prev)) sel.value = prev;

  renderHistory();
}

function renderHistory() {
  const q = $('#search').value.trim().toLowerCase();
  const domain = $('#domainFilter').value;
  const onlyStar = $('#onlyStar').checked;

  historyFiltered = allRecords.filter((r) => {
    if (domain && r.domain !== domain) return false;
    if (onlyStar && !r.favorite) return false;
    if (!q) return true;
    return [r.selection, r.question, r.answer, r.title, r.domain]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });

  const total = allRecords.length;
  const star = allRecords.filter((r) => r.favorite).length;
  $('#histStat').textContent =
    total === 0
      ? '暂无记录'
      : `共 ${total} 条 · 收藏 ${star} 条 · 当前筛选出 ${historyFiltered.length} 条`;

  const list = $('#histList');
  $('#histEmpty').hidden = historyFiltered.length > 0;

  const LIMIT = 150;
  const shown = historyFiltered.slice(0, LIMIT);

  list.innerHTML = shown
    .map(
      (r) => `
    <div class="hist-item" data-id="${escapeHtml(r.id)}">
      <div class="hist-head">
        <div class="hist-main">
          <div class="hist-sel">${escapeHtml(r.selection || '(无选中内容)')}</div>
          <div class="hist-meta">
            <span class="tag">${escapeHtml(MODES[r.mode]?.label || r.mode || '')}</span>
            ${r.question ? `<span>问：${escapeHtml(r.question)}</span>` : ''}
            <span>${escapeHtml(r.domain || '未知来源')}</span>
            <span>${formatTime(r.ts)}</span>
          </div>
        </div>
        <div class="hist-actions">
          <button class="icon-btn ${r.favorite ? 'on' : ''}" data-act="star" title="收藏">${r.favorite ? '★' : '☆'}</button>
          <button class="icon-btn del" data-act="del" title="删除">✕</button>
        </div>
      </div>
      <div class="hist-body" hidden>
        ${r.url ? `<div class="hist-body src">来源：${escapeHtml(r.title || r.url)}\n${escapeHtml(r.url)}</div>` : ''}
        <div>${escapeHtml(r.answer || '(空)')}</div>
      </div>
    </div>`
    )
    .join('');

  if (historyFiltered.length > LIMIT) {
    list.insertAdjacentHTML(
      'beforeend',
      `<div class="empty">只显示了最近 ${LIMIT} 条。用搜索或筛选缩小范围，或直接导出全部。</div>`
    );
  }
}

function bindHistoryDelegation() {
  $('#histList').addEventListener('click', async (e) => {
    const item = e.target.closest('.hist-item');
    if (!item) return;
    const id = item.dataset.id;
    const record = allRecords.find((r) => r.id === id);
    if (!record) return;

    const act = e.target.closest('[data-act]')?.dataset.act;

    if (act === 'star') {
      const next = !record.favorite;
      await send({ type: 'history:update', id, patch: { favorite: next } });
      record.favorite = next;
      loadHistory();
      return;
    }

    if (act === 'del') {
      await send({ type: 'history:delete', id });
      allRecords = allRecords.filter((r) => r.id !== id);
      loadHistory();
      toast('已删除');
      return;
    }

    const body = item.querySelector('.hist-body');
    if (body) body.hidden = !body.hidden;
  });
}

async function onExport() {
  const rows = historyFiltered.length ? historyFiltered : allRecords;
  if (!rows.length) {
    toast('没有可导出的记录');
    return;
  }

  const res = await send({ type: 'history:export', records: rows });
  if (!res?.ok) {
    toast(`导出失败：${res?.error || '未知错误'}`, 3200);
    return;
  }

  const blob = new Blob([res.markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename: `AI阅读助手-问答记录-${today()}.md`,
      saveAs: true,
    });
    toast(`已导出 ${rows.length} 条`);
  } catch (err) {
    toast(`下载失败：${err?.message || err}`, 3200);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function onClear() {
  const total = allRecords.length;
  if (!total) return;
  const star = allRecords.filter((r) => r.favorite).length;
  const keepFavorites = star > 0 && confirm(
    `共 ${total} 条记录，其中 ${star} 条已收藏。\n\n点「确定」= 只保留收藏（删除 ${total - star} 条）\n点「取消」= 什么都不做`
  );
  if (!keepFavorites && star > 0 && !confirm(`确定要连同 ${star} 条收藏一起全部清空？此操作不可撤销。`)) {
    return;
  }
  if (!star && !confirm(`确定清空全部 ${total} 条记录？此操作不可撤销。`)) return;

  const res = await send({ type: 'history:clear', keepFavorites });
  if (res?.ok) {
    toast(keepFavorites ? `已清理，保留 ${res.count} 条收藏` : '已清空');
    loadHistory();
  }
}

/* ================================================================
 * 启动
 * ================================================================ */

async function bootstrap() {
  fillPresetOptions();
  fillModeOptions();
  bindForm();
  bindHistoryDelegation();

  $('#exportObsidianBtn').addEventListener('click', () => pushBatchTo('obsidian'));
  $('#exportNotionBtn').addEventListener('click', () => pushBatchTo('notion'));

  updateModeCheckHint = () => {};

  const res = await send({ type: 'settings:get' });
  fillForm(res?.settings || DEFAULT_SETTINGS);

  await renderPermissions();

  const hist = await send({ type: 'history:list' });
  $('#histCount').textContent = String((hist?.records || []).length);

  // 支持从弹窗直接跳到某个标签页：options.html#history
  const hash = location.hash.replace('#', '');
  if (hash === 'history' || hash === 'general') {
    const tab = document.querySelector(`.tab[data-tab="${hash}"]`);
    if (tab) {
      tab.click();
      return;
    }
  }

  if (!currentSettings.apiKey) {
    $('#apiKey').focus();
  }
}

bootstrap();
