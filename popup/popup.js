/** 扩展图标弹窗：一眼看清「配没配好」和「最近问了什么」 */

const send = (msg) => chrome.runtime.sendMessage(msg);

function escapeHtml(input) {
  return String(input == null ? '' : input).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const date = new Date(ts);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

const MODE_LABEL = {
  explain: '解释',
  translate: '翻译',
  example: '举例',
  deeper: '深入',
  summarize: '总结',
  ask: '追问',
};

function openOptions(tab) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html${tab ? `#${tab}` : ''}`) });
  window.close();
}

/** 缺哪一项就说哪一项——含糊的「未配置」会让用户以为自己配好了 */
function missingOf(settings) {
  const miss = [];
  if (!settings.baseUrl) miss.push('接口地址');
  if (!settings.apiKey) miss.push('API Key');
  if (!settings.model) miss.push('模型名');
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
    line.textContent = '读取设置失败';
    tipText.textContent = `无法读取设置：${error}。点「设置」重试，或到扩展管理页重新加载一次插件。`;
    tip.hidden = false;
    return;
  }

  const missing = missingOf(settings);
  if (missing.length) {
    line.textContent = `未配置 · 还差 ${missing.join(' / ')}`;
    tipText.textContent = `还没有配置模型：缺少 ${missing.join('、')}。填好后点「保存并测试连接」，弹窗这里就会认到。`;
    tip.hidden = false;
    return;
  }

  line.textContent = `${settings.model} · ${recordCount} 条记录`;
  tip.hidden = true;
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
    if (settingsRes?.ok === false) error = settingsRes.error || '后台返回异常';
    if (historyRes?.ok === false && !error) error = historyRes.error || '后台返回异常';
    settings = settingsRes?.settings || {};
    records = historyRes?.records || [];
  } catch (err) {
    error = String(err?.message || err);
  }

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
        <div class="rec-sel">${escapeHtml(r.selection || '(无选中内容)')}</div>
        <div class="rec-meta">
          <span class="tag">${escapeHtml(MODE_LABEL[r.mode] || r.mode || '')}</span>
          <span>${escapeHtml(r.domain || '未知来源')}</span>
          <span>${timeAgo(r.ts)}</span>
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
