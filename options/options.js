/**
 * 设置页
 *
 * 一个刻意的设计：「保存并测试」是**一个**动作，不是两个。
 * 因为「测试通过」和「实际使用时失败」同时为真的经典成因，
 * 就是测试读表单值、而真正干活读持久化值。先保存再测试，两者永远一致。
 */

import { PRESETS, presetLabel, protocolLabel, originPatternOf } from '../lib/llm.js';
import { DEFAULT_SETTINGS, AUTO_FOLDER } from '../lib/store.js';
import { t, setLocale, applyDom, getLocale, timeAgo, applyLanguageSetting } from '../lib/i18n.js';
import {
  normalizeNotionId,
  looksLikeNotionId,
  obsidianUri,
  obsidianFilePath,
  resolveObsidianFolder,
  sanitizeName,
} from '../lib/exporters.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const send = (msg) => chrome.runtime.sendMessage(msg);

/** 动作 key 的顺序（与 lib/prompts.js 的 MODES 一致），显示名从字典取 */
const MODE_KEYS = ['explain', 'translate', 'example', 'deeper', 'summarize', 'ask'];

const modeLabel = (key) => t(`mode_${key}_label`);

/** 列举分隔符：中文顿号、英文逗号 */
const listSep = () => (getLocale() === 'zh' ? '、' : ', ');

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
    opt.textContent = presetLabel(p.id);
    sel.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = t('optCustomProvider');
  sel.appendChild(custom);
}

/** 协议下拉的两项：文案在字典里，value 是稳定的机器 key */
function fillProtocolOptions() {
  const sel = $('#protocol');
  sel.innerHTML = '';
  for (const [value, key] of [
    ['openai', 'optProtocolOpenai'],
    ['anthropic', 'optProtocolAnthropic'],
  ]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = t(key);
    sel.appendChild(opt);
  }
}

/** 界面语言下拉：auto 走字典，两个语言名用各自的语言写（endonym，不随界面语言变） */
function fillLanguageOptions() {
  const sel = $('#language');
  sel.innerHTML = '';
  const items = [
    ['auto', t('optLanguageAuto')],
    ['zh', t('langZh')],
    ['en', t('langEn')],
  ];
  for (const [value, label] of items) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  }
}

/**
 * 页面上下文下拉。
 * 三档之间的差别主要是「有多少页面内容会被发出去」，所以选项名必须自解释 ——
 * 只写「开 / 关」会让人不知道自己正在把整篇文档交给模型服务。
 */
function fillPageContextOptions() {
  const sel = $('#pageContext');
  sel.innerHTML = '';
  const items = [
    ['off', t('optPageCtxOff')],
    ['auto', t('optPageCtxAuto')],
    ['always', t('optPageCtxAlways')],
  ];
  for (const [value, label] of items) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  }
}

function fillModeOptions() {
  const sel = $('#defaultMode');
  const quick = $('#quickAskMode');
  sel.innerHTML = '';
  quick.innerHTML = '';
  const checks = $('#modeChecks');
  checks.innerHTML = '';

  for (const key of MODE_KEYS) {
    if (key === 'ask') continue; // 追问要先有用户的问题，不能当默认动作或双击动作

    for (const target of [sel, quick]) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = modeLabel(key);
      target.appendChild(opt);
    }

    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" value="${key}"><span>${escapeHtml(modeLabel(key))}</span>`;
    checks.appendChild(label);
    label.querySelector('input').addEventListener('change', updateModeCheckHint);
  }
}

let updateModeCheckHint = () => {};

/**
 * 读 Obsidian 文件夹输入框。
 *
 * 输入框里显示的就是「当前语言的默认名」时，仍然存回哨兵值 AUTO_FOLDER ——
 * 否则用户点一次保存，文件夹名就被钉死在当时那门语言上，
 * 以后把界面切成英文，笔记还是会往中文文件夹里写。
 */
function readObsidianFolder() {
  const raw = $('#obsidianFolder').value.trim();
  return raw === resolveObsidianFolder(AUTO_FOLDER) ? AUTO_FOLDER : raw;
}

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
    language: $('#language').value || 'auto',
    pageContext: $('#pageContext').value || 'off',
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
    obsidianFolder: readObsidianFolder(),
    notionToken: $('#notionToken').value.trim(),
    notionParentId: normalizeNotionId($('#notionParentId').value),
    configured: !!( $('#baseUrl').value.trim() && $('#apiKey').value.trim() && $('#model').value.trim()),
  };
}

/**
 * 应用界面语言。
 *
 * 顺序很讲究：先 setLocale，再 applyDom（静态骨架），最后重填动态生成的下拉/复选框 ——
 * 那些是用 JS 拼出来的，applyDom 管不到，必须重建。
 */
function applyLanguage(language) {
  applyLanguageSetting({ language });
  applyDom(document);
  document.title = t('optDocTitle');
  fillProtocolOptions();
  fillPresetOptions();
  fillModeOptions();
  fillLanguageOptions();
  fillPageContextOptions();

  // 重填之后要把当前值放回去，否则下拉会跳回第一项
  $('#preset').value = PRESETS.some((p) => p.id === currentSettings.preset)
    ? currentSettings.preset
    : 'custom';
  $('#protocol').value = currentSettings.protocol || 'openai';
  $('#language').value = currentSettings.language || 'auto';
  $('#pageContext').value = currentSettings.pageContext || 'off';
  $('#defaultMode').value = currentSettings.defaultMode || 'explain';
  $('#quickAskMode').value = currentSettings.quickAskMode || 'explain';
  const enabled = new Set(currentSettings.selectedModes || DEFAULT_SETTINGS.selectedModes);
  $$('#modeChecks input').forEach((i) => {
    i.checked = enabled.has(i.value);
  });
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

  $('#language').value = currentSettings.language || 'auto';
  $('#pageContext').value = currentSettings.pageContext || 'off';

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
  // 'auto' 哨兵显示成当前语言的默认文件夹名：用户看到的就是实际会写进去的名字
  $('#obsidianFolder').value = resolveObsidianFolder(currentSettings.obsidianFolder);
  $('#notionToken').value = currentSettings.notionToken || '';
  $('#notionParentId').value = currentSettings.notionParentId || '';
  renderIntegrateHint();

  $('#keyHint').textContent = currentSettings.apiKey ? t('optKeyHintSet') : t('optKeyHintEmpty');

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
    $('#toggleKey').textContent = show ? t('optHideKey') : t('optShowKey');
  });

  // 语言切换要立刻重绘整页 —— 这是唯一一个「改了要重建 DOM」的偏好
  $('#language').addEventListener('change', async (e) => {
    currentSettings.language = e.target.value;
    applyLanguage(e.target.value);
    renderIntegrateHint();
    $('#keyHint').textContent = currentSettings.apiKey ? t('optKeyHintSet') : t('optKeyHintEmpty');
    if (allRecords.length) renderHistory();
    await persistQuiet({ language: e.target.value });
    toast(t('optLanguageChanged'), 1600);
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
  // 「页面上下文」是往外发多少内容的开关，改完立刻落盘 ——
  // 用户以为自己已经关掉了、实际还在发，是这里最不能出的错
  $('#pageContext').addEventListener('change', (e) => persistQuiet({ pageContext: e.target.value }));
  $('#modeChecks').addEventListener('change', () => {
    const modes = $$('#modeChecks input:checked').map((i) => i.value);
    if (!modes.includes('ask')) modes.push('ask');
    persistQuiet({ selectedModes: modes });
  });

  $('#saveBtn').addEventListener('click', onSaveAndTest);
  $('#testOnlyBtn').addEventListener('click', () => runTest({ useForm: true }));
  $('#refreshPerm').addEventListener('click', () => {
    renderPermissions();
    toast(t('optPermRefreshed'));
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
  if (!res?.ok) toast(t('optSaveFailedDetail', { msg: res?.error || t('optUnknownError') }), 3200);
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
    return { ok: false, message: t('optPermPatternMissing') };
  }
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return { ok: true, pattern };
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (granted) return { ok: true, pattern, fresh: true };
    return { ok: false, message: t('optPermDenied', { pattern }) };
  } catch (err) {
    return { ok: false, message: t('optPermRequestFailed', { msg: err?.message || err }) };
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
    box.innerHTML = `<div class="perm-empty">${escapeHtml(t('optPermEmpty'))}</div>`;
    return;
  }
  box.innerHTML = real
    .map(
      (o) =>
        `<div class="perm-item"><span class="pill">${escapeHtml(t('optPermGranted'))}</span>${escapeHtml(o)}</div>`
    )
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
    note.textContent = t('optIntegrateNoteNotionReady');
  } else if (hasToken || hasParent) {
    note.textContent = t('optIntegrateNoteNotionPartial');
  } else {
    note.textContent = t('optIntegrateNoteIdle');
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
    note.textContent = t('optNotionPermFailed', { msg: err?.message || err });
    return;
  }
  if (!granted) {
    note.textContent = t('optNotionPermDenied');
    return;
  }

  const token = $('#notionToken').value.trim();
  const parent = normalizeNotionId($('#notionParentId').value);
  if (!token) {
    note.textContent = t('optNotionNeedToken');
    return;
  }
  $('#notionParentId').value = parent;
  await persistQuiet({ notionToken: token, notionParentId: parent });

  btn.disabled = true;
  const idleLabel = t('optNotionConnect');
  btn.textContent = t('optNotionConnecting');
  try {
    const res = await send({ type: 'export:test-notion', token, parentId: parent });
    note.textContent = res?.ok
      ? t('optNotionConnectOk', { bot: res.botName, parent: res.parentTitle })
      : t('optNotionConnectFailed', { msg: res?.error || t('optUnknownError') });
    await renderPermissions();
  } catch (err) {
    note.textContent = t('optNotionConnectFailed', { msg: err?.message || err });
  } finally {
    btn.disabled = false;
    btn.textContent = idleLabel;
  }
}

/** 往 Obsidian 写一篇测试笔记，用来确认库名/文件夹填对了 */
async function onObsidianTest() {
  const note = $('#integrateNote');
  const vault = $('#obsidianVault').value.trim();
  const folder = readObsidianFolder();
  const name = sanitizeName(t('optObsidianTestTitle'), 60);
  const content = [
    t('optObsidianTestFile'),
    '',
    t('optObsidianTestIntro'),
    '',
    t('optObsidianTestVault', { vault: vault || t('optObsidianTestVaultRecent') }),
    t('optObsidianTestFolder', { folder: folder || t('optObsidianTestFolderEmpty') }),
    '',
  ].join('\n');

  try {
    await chrome.tabs.create({
      url: obsidianUri({ vault, file: obsidianFilePath(folder, name), content }),
    });
    note.textContent = t('optObsidianTestSent');
  } catch (err) {
    note.textContent = t('optObsidianTestFailed', { msg: err?.message || err });
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
    toast(t('optNoRecordsToSend'));
    return;
  }
  if (target === 'obsidian' && rows.length > 10) {
    if (!confirm(t('optBatchConfirm', { n: rows.length }))) return;
  }

  const btn = target === 'obsidian' ? $('#exportObsidianBtn') : $('#exportNotionBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('optSending');
  try {
    const res = await send({ type: 'export:save', target, records: rows });
    if (!res?.ok) {
      toast(res?.error || t('optSendFailed'), 4200);
      return;
    }
    if (target === 'obsidian') {
      toast(
        res.chunks > 1
          ? t('optSentObsidianChunks', { file: res.file, n: res.chunks })
          : t('optSentObsidian', { file: res.file }),
        3600
      );
    } else {
      toast(t('optSentNotion', { n: rows.length }), 3600);
    }
  } catch (err) {
    toast(t('optSendFailedDetail', { msg: err?.message || err }), 4200);
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
  const idleLabel = t('optSaveAndTest');
  btn.textContent = t('optSaving');

  try {
    const patch = readForm();

    // 顺序很重要：权限申请必须发生在用户手势的调用栈内
    const perm = await ensurePermission(patch.baseUrl);

    const saved = await send({ type: 'settings:save', patch });
    if (!saved?.ok) throw new Error(saved?.error || t('optSaveFailed'));
    currentSettings = saved.settings;
    markSaved(); // 已落盘，未保存提示随之消失

    if (!perm.ok) {
      showResult('err', perm.message);
      return;
    }

    btn.textContent = t('optTesting');
    await renderPermissions();
    // 不传 config：让 SW 读刚保存的持久化设置，测试路径 === 执行路径
    await runTest({ useForm: false });
  } catch (err) {
    showResult('err', String(err?.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = idleLabel;
  }
}

async function runTest({ useForm }) {
  const box = $('#testResult');
  box.hidden = false;
  box.className = 'result loading';
  box.textContent = t('optTestingNow');

  const config = useForm ? readForm() : undefined;
  const res = await send({ type: 'settings:test', config });

  if (res?.ok) {
    box.className = 'result ok';
    box.innerHTML =
      `${t('optTestOkHtml', {
        endpoint: escapeHtml(res.endpoint),
        model: escapeHtml(res.model),
        ms: res.elapsed,
        reply: escapeHtml(res.reply || t('optTestEmptyReply')),
      })}` + (useForm ? t('optTestNotSavedHtml') : '');
  } else {
    box.className = 'result err';
    box.innerHTML = t('optTestFailHtml', { msg: escapeHtml(res?.error || t('optUnknownError')) });
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
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = t('optAllSources');
  sel.appendChild(all);
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
      ? t('optHistStatEmpty')
      : t('optHistStat', { total, star, shown: historyFiltered.length });

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
          <div class="hist-sel">${escapeHtml(r.selection || t('noSelection'))}</div>
          <div class="hist-meta">
            <span class="tag">${escapeHtml(modeLabel(r.mode))}</span>
            ${r.question ? `<span>${escapeHtml(t('optQuestionTag', { q: r.question }))}</span>` : ''}
            <span>${escapeHtml(r.domain || t('unknownSource'))}</span>
            <span>${escapeHtml(formatTime(r.ts))}</span>
          </div>
        </div>
        <div class="hist-actions">
          <button class="icon-btn ${r.favorite ? 'on' : ''}" data-act="star" title="${escapeHtml(t('optStarTitle'))}">${r.favorite ? '★' : '☆'}</button>
          <button class="icon-btn del" data-act="del" title="${escapeHtml(t('optDelTitle'))}">✕</button>
        </div>
      </div>
      <div class="hist-body" hidden>
        ${r.url ? `<div class="hist-body src">${escapeHtml(t('optHistSource', { title: r.title || r.url, url: r.url }))}</div>` : ''}
        <div>${escapeHtml(r.answer || t('mdEmpty'))}</div>
      </div>
    </div>`
    )
    .join('');

  if (historyFiltered.length > LIMIT) {
    list.insertAdjacentHTML(
      'beforeend',
      `<div class="empty">${escapeHtml(t('optHistLimit', { n: LIMIT }))}</div>`
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
      toast(t('optDeleted'));
      return;
    }

    const body = item.querySelector('.hist-body');
    if (body) body.hidden = !body.hidden;
  });
}

async function onExport() {
  const rows = historyFiltered.length ? historyFiltered : allRecords;
  if (!rows.length) {
    toast(t('optExportEmpty'));
    return;
  }

  const res = await send({ type: 'history:export', records: rows });
  if (!res?.ok) {
    toast(t('optExportFailed', { msg: res?.error || t('optUnknownError') }), 3200);
    return;
  }

  const blob = new Blob([res.markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename: t('optExportFileName', { date: today() }),
      saveAs: true,
    });
    toast(t('optExported', { n: rows.length }));
  } catch (err) {
    toast(t('optDownloadFailed', { msg: err?.message || err }), 3200);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function onClear() {
  const total = allRecords.length;
  if (!total) return;
  const star = allRecords.filter((r) => r.favorite).length;
  const keepFavorites =
    star > 0 && confirm(t('optClearConfirm', { total, star, keep: total - star }));
  if (!keepFavorites && star > 0 && !confirm(t('optClearConfirmStar', { star }))) {
    return;
  }
  if (!star && !confirm(t('optClearConfirmAll', { total }))) return;

  const res = await send({ type: 'history:clear', keepFavorites });
  if (res?.ok) {
    toast(keepFavorites ? t('optClearedKeep', { n: res.count }) : t('optCleared'));
    loadHistory();
  }
}

/* ================================================================
 * 启动
 * ================================================================ */

async function bootstrap() {
  bindForm();
  bindHistoryDelegation();

  $('#exportObsidianBtn').addEventListener('click', () => pushBatchTo('obsidian'));
  $('#exportNotionBtn').addEventListener('click', () => pushBatchTo('notion'));

  updateModeCheckHint = () => {};

  const res = await send({ type: 'settings:get' });
  const settings = res?.settings || DEFAULT_SETTINGS;
  currentSettings = { ...DEFAULT_SETTINGS, ...settings };

  // 语言必须先定下来再渲染任何东西：否则会先按浏览器语言画一屏，再闪成设置里的语言
  applyLanguage(currentSettings.language);
  fillForm(settings);

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
