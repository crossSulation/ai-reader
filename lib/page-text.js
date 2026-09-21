/**
 * 网页正文抽取的 ESM 出入口。
 *
 * 算法与阈值都在 lib/page-text.core.js —— 那个文件写成「经典脚本」形态，
 * 因为 content script 不是 ESM 环境（它要靠这个文件去遍历 DOM），
 * 这里只把它挂在 globalThis 上的那套 API 重新导出成模块接口，
 * 好让 service worker / 自测能 import 同一份实现。
 *
 * 两套加载形态共用一份算法，所以「设置页说的上限」和「内容脚本实际用的上限」
 * 不可能对不上 —— 这是本项目在 i18n 上已经吃过一次亏后定下的规矩。
 */

import './page-text.core.js';

const api = globalThis.AI_READER_PAGE_TEXT;

/** 单次正文的硬上限（字符） */
export const PAGE_TEXT_MAX = api.PAGE_TEXT_MAX;

/** 正文最多占整次请求预算的比例 */
export const PAGE_TEXT_RATIO = api.PAGE_TEXT_RATIO;

/** auto 档的触发线：所在段落短于这么多字就补整页 */
export const AUTO_TRIGGER_BELOW = api.AUTO_TRIGGER_BELOW;

/** 采集侧要用的标签/角色黑名单与阈值（content script 也读同一份） */
export const BLOCK_TAGS = api.BLOCK_TAGS;
export const NOISE_TAGS = api.NOISE_TAGS;
export const NOISE_ROLES = api.NOISE_ROLES;
export const LINK_DENSITY_LIMIT = api.LINK_DENSITY_LIMIT;
export const MAX_ELEMENTS = api.MAX_ELEMENTS;
export const MAX_DEPTH = api.MAX_DEPTH;
export const MAX_BLOCK_CHARS = api.MAX_BLOCK_CHARS;

/** 这一轮要不要去采集整页正文（设置档位 × 所在段落长度） */
export const shouldCollect = (setting, contextText) => api.shouldCollect(setting, contextText);

/** 本轮正文的字符上限（受总预算约束） */
export const pageMax = (charBudget) => api.pageMax(charBudget);

/** path 是否落在 prefix 子树里 */
export const isUnder = (path, prefix) => api.isUnder(path, prefix);

/** 路径的所有严格前缀（祖先容器），由外到内 */
export const ancestorsOf = (path) => api.ancestorsOf(path);

/** 去掉祖先块，只留最内层 */
export const pruneNested = (blocks) => api.pruneNested(blocks);

/** 挑出主内容容器的路径前缀（空串 = 没有明显主体） */
export const pickRoot = (blocks) => api.pickRoot(blocks);

/** 渲染单个块（标题带 #、列表项带 -、pre 保留缩进） */
export const renderBlock = (block) => api.renderBlock(block);

/** 单个块的文本规范化（pre 与非 pre 的空白处理不同，别在别处再写一遍） */
export const normalizeBlock = (text, isPre) => api.normalize(text, isPre);

/**
 * 把块整理成正文。
 * @param {Array} blocks [{ p, t, x, l }]，顺序即文档顺序
 * @param {{max?: number}} [opts]
 */
export const build = (blocks, opts) => api.build(blocks, opts);
