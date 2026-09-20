/** 扩展图标弹窗：一眼看清「配没配好」和「最近问了什么」 */

import { t, setLocale, applyDom, applyLanguageSetting, timeAgo } from '../lib/i18n.js';

const send = (msg) => chrome.runtime.sendMessage(msg);

function escapeHtml(input) {
  return String(input == null ? '' : input).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const MODES = ['explain', 'translate', 'example', 'deeper', 'summarize', 'ask'];

/** 动作名；未知 key 不显示 key 名，退到「提问」 */
function modeLabel(mode) {
  return MODES.includes(mode) ? t(`mode_${mode}_label`) : t('mode_ask_label');
}

function openOptions(tab) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html${tab ? `#${tab}` : ''}`) });
  window.close();
}

/** 缺哪一项就说哪一项——含糊的「未配置」会让用户以为自己配好了 */
function missingOf(settings) {
  const miss = [];
  if (!settings.baseUrl) miss.push(t('fieldBaseUrl'));
  if (!settings.apiKey) miss.push(t('fieldApiKey'));
  if (!settings.model) miss.push(t('fieldModel'));
  return miss;
}

/**
 * 顶栏状态 + 提示条。
 *
 * 三种状态严格区分，绝不混为一谈：
 *   - 读不到设置（后台没响应）→ 说「读取失败」，不能让用户以为是自己没配
 *   - 确实缺字段 → 明确列出缺什么
 *   - 配好了 → 提示条隐藏
 */
function renderStatus({ settings = {}, error = '', recordCount = 0 }) {
  const line = document.querySelector('#modelLine');
  const tip = document.querySelector('#tip');
  const tipText = document.querySelector('#tipText');

  if (error) {
    line.textContent = t('popupReadFailed');
    tipText.textContent = t('popupReadFailedDetail', { msg: error });
    tip.hidden = false;
    return;
  }

  const missing = missingOf(settings);
  if (missing.length) {
    // 顶栏用「/」紧凑列举，提示条用顿号/逗号展开成句子 —— 两种语言的标点习惯不同
    line.textContent = t('popupMissingLine', { list: missing.join(' / ') });
    tipText.textContent = t('popupMissingDetail', { list: missing.join(listSeparator()) });
    tip.hidden = false;
    return;
  }

  line.textContent = t('popupReady', { model: settings.model, n: recordCount });
  tip.hidden = true;
}

/** 列举分隔符：中文顿号、英文逗号 */
function listSeparator() {
  return document.documentElement.lang.startsWith('zh') ? '、' : ', ';
}

async function bootstrap() {
  let settings = {};
  let records = [];
  let error = '';

  try {
    const [settingsRes, historyRes] = await Promise.all([
      send({ type: 'settings:get' }),
      send({ type: 'history:list' }),
    ]);
    // 后台返回了结构化的失败（而不是抛异常），也要当成错误说出去
    if (settingsRes?.ok === false) error = settingsRes.error || t('popupBackendError');
    if (historyRes?.ok === false && !error) error = historyRes.error || t('popupBackendError');
    settings = settingsRes?.settings || {};
    records = historyRes?.records || [];
  } catch (err) {
    error = String(err?.message || err);
  }

  // 语言必须在渲染之前定：先按浏览器语言画一帧再被设置改掉，就是「闪一下换语言」
  applyLanguageSetting(settings);
  applyDom(document);

  renderStatus({ settings, error, recordCount: records.length });

  const list = document.querySelector('#recentList');
  const empty = document.querySelector('#recentEmpty');

  if (!records.length) {
    empty.hidden = false;
  } else {
    const recent = records.slice(0, 6);
    list.innerHTML = recent
      .map(
        (r) => `
      <button class="rec" data-id="${escapeHtml(r.id)}">
        <div class="rec-sel">${escapeHtml(r.selection || t('noSelection'))}</div>
        <div class="rec-meta">
          <span class="tag">${escapeHtml(modeLabel(r.mode))}</span>
          <span>${escapeHtml(r.domain || t('unknownSource'))}</span>
          <span>${escapeHtml(timeAgo(r.ts))}</span>
          ${r.favorite ? '<span>★</span>' : ''}
        </div>
      </button>`
      )
      .join('');
    list.addEventListener('click', () => openOptions('history'));
  }

  document.querySelector('#goSetup').addEventListener('click', () => openOptions('general'));
  document.querySelector('#openSettings').addEventListener('click', () => openOptions('general'));
  document.querySelector('#openHistory').addEventListener('click', () => openOptions('history'));
}

bootstrap();
