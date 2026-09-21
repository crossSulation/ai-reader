/**
 * 网页正文抽取 —— 纯数据部分（本文件不碰 DOM）。
 *
 * 为什么要有这个文件：
 *   划词问答的默认素材只有「所在段落」，这在读技术文档时经常不够 ——
 *   用户问「上面那个概念是什么」，答案在上一节里，而段落只截了一小段。
 *   所以给一个可选项，把整页正文也送进上下文。
 *
 * 为什么不能直接 body.innerText：
 *   导航栏、侧边栏、目录、相关阅读、评论、页脚会一并进来。它们动辄占掉一半字符，
 *   既费 token（用户自己付钱）又干扰模型判断「这篇文章在讲什么」。
 *
 * 为什么算法放这里而不是 content script：
 *   content script 只能收发，策略必须留在能 import 的一侧 —— 这是本项目的老规矩。
 *   而且这样「去嵌套 / 选容器 / 拼装 / 截断」全是纯函数，能在 Node 里直接测。
 *   DOM 采集（拿 innerText、判可见性）留在 content/content.js，
 *   它只负责把 DOM 翻译成 [{ p, t, x, l }] 这样的朴素数据：
 *     p = 元素在文档树里的路径（如 "0.2.1"，逗号分层，用于判断祖先关系与文档序）
 *     t = 标签名（小写）
 *     x = 文本
 *     l = 该块里 <a> 文本的总长度（用来算链接密度）
 *
 * 双重加载形态（与 lib/i18n.core.js 同一套）：
 *   经典脚本形式（内容脚本不是 ESM 环境，import 不进来）——挂 globalThis.AI_READER_PAGE_TEXT；
 *   ESM 侧经 lib/page-text.js 薄封装使用同一份实现，不存在两套算法漂移的问题。
 */
(function (global) {
  'use strict';

  /**
   * 整页正文的单次上限（字符）。
   * 8000 足够覆盖绝大多数技术文档与博客全文；真超长的（论文、电子书）会被截断，
   * 且截断这件事必须一路报到面板上 —— 静默丢内容比截断本身更糟。
   */
  const PAGE_TEXT_MAX = 8000;

  /**
   * 正文最多能占整次请求预算的比例。
   * 不能让它吃光预算：历史对话、所在段落、选中内容都要位置。
   */
  const PAGE_TEXT_RATIO = 0.4;

  /** 自适应下限：预算再小也别把正文压到没意义，几百字换不来任何上下文 */
  const PAGE_TEXT_FLOOR = 500;

  /**
   * auto 档的触发线。
   * 所在段落短于这个字数，说明划词落在了一个「没有语义块可依附」的地方
   * （裸文本、画布文字、组件拼出来的页面），这时才补整页兜底。
   */
  const AUTO_TRIGGER_BELOW = 200;

  /** 视为「正文块」的标签：只有这些标签的文本会被采集成候选段落 */
  const BLOCK_TAGS = new Set([
    'p', 'li', 'pre', 'blockquote', 'dd', 'dt', 'td', 'th',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'figcaption', 'summary', 'caption',
  ]);

  /**
   * 整棵剪掉的噪音标签。
   * 注意这里剪的是「标签级」噪音；大量站点的导航并不用 <nav>，
   * 那部分靠 LINK_DENSITY_LIMIT 兜。
   */
  const NOISE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
    'NAV', 'ASIDE', 'FOOTER', 'HEADER', 'FORM',
    'BUTTON', 'SELECT', 'TEXTAREA', 'LABEL', 'INPUT', 'OPTION', 'DIALOG',
    'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'MAP', 'AREA',
  ]);

  /** ARIA 地标同样是噪音，且比标签更可靠（框架组件经常用 role 而不是语义标签） */
  const NOISE_ROLES = new Set([
    'navigation', 'banner', 'contentinfo', 'complementary', 'search',
    'dialog', 'alertdialog', 'menu', 'menubar', 'toolbar', 'tablist', 'form',
  ]);

  /**
   * 链接密度上限。
   * 导航、目录、相关阅读、页脚链接列表的文本几乎全是 <a>；正文段落里链接占比很低。
   * 这条比标签黑名单可靠得多。
   */
  const LINK_DENSITY_LIMIT = 0.5;

  /** 元素遍历上限：防止极端页面（几万个节点）把主线程占住 */
  const MAX_ELEMENTS = 12000;

  /** DOM 层级上限：正常页面远低于它，超了说明在病态结构里，直接停 */
  const MAX_DEPTH = 64;

  /** 单个块的文本上限：某些站点把整篇文章塞进一个 <p>，超长块没有参考价值 */
  const MAX_BLOCK_CHARS = 20000;

  /**
   * 要不要为这一轮去采集整页正文。
   *
   * 采集要遍历整个 DOM，不便宜，所以先判定再动手：
   *   off    —— 从不采集（默认：正文外发是用户主动选择的事，不该默认发生）
   *   auto   —— 只在「所在段落不足以支撑回答」时兜底
   *   always —— 每轮都带
   *
   * @param {string} setting      设置项 pageContext 的值
   * @param {string} contextText  本轮划词所在的段落
   * @returns {boolean}
   */
  function shouldCollect(setting, contextText) {
    if (setting === 'always') return true;
    if (setting === 'auto') {
      return String(contextText == null ? '' : contextText).trim().length < AUTO_TRIGGER_BELOW;
    }
    return false;
  }

  /**
   * 本轮正文的字符上限：受总预算约束，最多占 PAGE_TEXT_RATIO。
   * 预算没给（或非法）时用硬上限。
   */
  function pageMax(charBudget) {
    const budget = Number(charBudget);
    if (!Number.isFinite(budget) || budget <= 0) return PAGE_TEXT_MAX;
    return Math.max(PAGE_TEXT_FLOOR, Math.min(PAGE_TEXT_MAX, Math.floor(budget * PAGE_TEXT_RATIO)));
  }

  /** path 是否落在 prefix 的子树里（含 prefix 自身） */
  function isUnder(path, prefix) {
    return path === prefix || path.startsWith(prefix + '.');
  }

  /**
   * 一个路径的所有严格前缀（祖先容器），由外到内。
   * "0.2.3" -> ["0.2", "0"]；"0" -> []。
   * 刻意不返回空串 —— 空串代表 body 整体，让它参与打分的话永远最高分，等于没筛选。
   */
  function ancestorsOf(path) {
    const out = [];
    let at = path.lastIndexOf('.');
    while (at > 0) {
      out.push(path.slice(0, at));
      at = path.lastIndexOf('.', at - 1);
    }
    return out;
  }

  /**
   * 去掉「祖先块」，只留最内层。
   * <li><p>文字</p></li> 会同时命中 li 和 p，两者文本几乎一样，
   * 不过滤就是同一段内容发两遍 —— 既费 token 又让模型以为那是两段。
   *
   * 做法：先把所有「被别的块当作祖先」的路径标出来，再滤掉它们。
   * 一遍 O(n × 深度)，比两两比较的 O(n²) 稳得多（长文档有几千个块）。
   */
  function pruneNested(blocks) {
    const isAncestor = new Set();
    for (const b of blocks) {
      for (const anc of ancestorsOf(b.p)) isAncestor.add(anc);
    }
    return blocks.filter((b) => !isAncestor.has(b.p));
  }

  /**
   * 挑出「主内容容器」：谁承载的正文多，谁就是正文。
   *
   * 打分方式是把每个块的字数记到它的所有祖先头上（块自己不算容器候选）。
   * 同分取路径更短的 —— 更靠上意味着覆盖更完整（典型页面里 article / div#app / body 的
   * 直接子容器会并列，取最高的那个才不会被内侧的某个小 div 切碎）。
   *
   * @returns {string} 路径前缀；空串表示没有明显主体，调用方应原样使用全部块
   */
  function pickRoot(blocks) {
    const score = new Map();
    for (const b of blocks) {
      const len = b.x ? b.x.length : 0;
      if (!len) continue;
      for (const anc of ancestorsOf(b.p)) score.set(anc, (score.get(anc) || 0) + len);
    }
    let best = '';
    let bestScore = 0;
    for (const [path, sc] of score) {
      if (sc > bestScore || (sc === bestScore && best && path.length < best.length)) {
        best = path;
        bestScore = sc;
      }
    }
    return bestScore > 0 ? best : '';
  }

  /**
   * 一个块的文本规范化。
   *
   * pre 特殊对待：代码块里的缩进就是信息，一旦按「连续空白压成一个」处理，
   * Python 和 YAML 的整段结构就毁了。所以 pre 只清理行尾空白与连续空行，
   * 行首缩进原样保留。
   */
  function normalize(text, isPre) {
    const raw = String(text == null ? '' : text);
    if (isPre) {
      return raw
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    return raw.replace(/\s+/g, ' ').trim();
  }

  /**
   * 渲染一个块。
   * 标题带上 Markdown 层级、列表项带 -，是为了让模型看出文档的骨架 ——
   * 不然一堆等权重的段落堆在一起，「这节在讲什么」就得多花 token 去猜。
   */
  function renderBlock(b) {
    const tag = String(b.t || '').toLowerCase();
    const isPre = tag === 'pre';
    const text = normalize(b.x, isPre);
    if (!text) return '';
    if (isPre) return text;
    if (tag === 'li') return `- ${text}`;
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${text}`;
    return text;
  }

  /**
   * 把收集到的块整理成一段正文。
   *
   * @param {Array}  blocks  [{ p, t, x, l }]，顺序即文档顺序（采集侧天然按文档序遍历）
   * @param {object} [opts]  { max } 字符上限
   * @returns {{ text, chars, totalChars, clipped, usedBlocks, totalBlocks }}
   *   totalChars 是「过滤后正文的总字数」，clipped 为真表示没装下 ——
   *   这两个值要一路报到面板上，让用户知道模型看到的不是全文。
   */
  function build(blocks, opts) {
    const max = Number(opts && opts.max) > 0 ? Math.floor(Number(opts.max)) : PAGE_TEXT_MAX;
    const list = Array.isArray(blocks) ? blocks : [];
    const leaves = pruneNested(list.filter((b) => b && b.p != null && b.x));

    const root = pickRoot(leaves);
    const picked = root ? leaves.filter((b) => isUnder(b.p, root)) : leaves;

    let totalChars = 0;
    const parts = [];
    let used = 0;
    let clipped = false;
    for (const b of picked) {
      const line = renderBlock(b);
      if (!line) continue;
      // 两个字数必须同口径：都按「渲染后、含分隔换行」来数。
      // 否则标题的 `# `、列表的 `- ` 会让已发送量反超总量，面板上就成了
      // 「已带上 127 字（共约 122 字）」这种自相矛盾的话。
      totalChars += line.length + 1;
      if (clipped) continue; // 已经装不下了，剩下的只统计长度
      if (used + line.length > max) {
        clipped = true;
        // 一个字都还没进的话，至少给出开头，否则「开了功能却什么都没发」更难排查
        if (!parts.length) {
          parts.push(line.slice(0, max));
          used = max;
        }
        continue;
      }
      parts.push(line);
      used += line.length + 1;
    }

    const text = parts.join('\n');
    return {
      text,
      chars: text.length,
      totalChars: Math.max(0, totalChars - 1),
      clipped,
      usedBlocks: parts.length,
      totalBlocks: picked.length,
    };
  }

  const api = {
    PAGE_TEXT_MAX,
    PAGE_TEXT_RATIO,
    PAGE_TEXT_FLOOR,
    AUTO_TRIGGER_BELOW,
    BLOCK_TAGS,
    NOISE_TAGS,
    NOISE_ROLES,
    LINK_DENSITY_LIMIT,
    MAX_ELEMENTS,
    MAX_DEPTH,
    MAX_BLOCK_CHARS,
    shouldCollect,
    pageMax,
    isUnder,
    ancestorsOf,
    pruneNested,
    pickRoot,
    normalize,
    renderBlock,
    build,
  };

  global.AI_READER_PAGE_TEXT = api;
})(globalThis);
