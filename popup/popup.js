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

async function bootstrap() {
  const [settingsRes, historyRes] = await Promise.all([
    send({ type: 'settings:get' }),
    send({ type: 'history:list' }),
  ]);

  const settings = settingsRes?.settings || {};
  const records = historyRes?.records || [];

  const configured = !!(settings.apiKey && settings.baseUrl && settings.model);
  document.querySelector('#modelLine').textContent = configured
    ? `${settings.model} · ${records.length} 条记录`
    : '未配置模型';
  document.querySelector('#tip').hidden = configured;

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
