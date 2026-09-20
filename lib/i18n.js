/**
 * i18n 的 ESM 出入口。
 *
 * 字典与解析逻辑都在 lib/i18n.core.js —— 那个文件写成「经典脚本」形态，
 * 因为 content script 不是 ESM 环境，import 不到模块，但能加载同目录的脚本文件。
 * 这里只做一层薄封装：把它挂到 globalThis 上的那套 API 重新导出成模块接口，
 * service worker / 设置页 / 弹窗 import 本文件即可，不必知道 globalThis 的存在。
 *
 * 两侧共用同一份字典，所以不存在「面板说中文、设置页说英文」这种半翻译状态。
 */

import './i18n.core.js';

const api = globalThis.AI_READER_I18N;

/**
 * 取文案。
 * @param {string} key   字典里的 key
 * @param {object} [subs] {name} 占位符的取值
 */
export const t = (key, subs) => api.t(key, subs);

/** 当前生效语言：'zh' | 'en' */
export const getLocale = () => api.getLocale();

/**
 * 指定界面语言。
 * @param {'zh'|'en'|'auto'|null} locale 'auto' / null = 跟随浏览器
 */
export const setLocale = (locale) => api.setLocale(locale);

/** 字典里有没有这个 key（测试与「可降级文案」判断用） */
export const has = (key) => api.has(key);

/** 只做占位符替换，不查字典（自测里单独验证替换语义） */
export const fill = (template, subs) => api.fill(template, subs);

/**
 * 语言标签归一化：zh-CN / zh_TW → 'zh'，en-US → 'en'，其它 → DEFAULT_LOCALE。
 * 设置页与自测都要用，务必经由这里导出，别让调用方自己写一套映射。
 */
export const normalize = (tag) => api.normalize(tag);

/** 浏览器当前语言（读不到时返回 DEFAULT_LOCALE），不读设置项 */
export const browserLocale = () => api.browserLocale();

/** 把 data-i18n* 属性应用到一段 DOM（document / shadow root / 元素都行） */
export const applyDom = (root) => api.applyDom(root);

/** 相对时间（刚刚 / 3 分钟前 / 2 小时前 / 5 天前 / 9月20日） */
export const timeAgo = (ts, now) => api.timeAgo(ts, now);

/** 短日期（9月20日 / Sep 20） */
export const formatDate = (ts) => api.formatDate(ts);

/** 字典本体，供测试断言「中英键集一致、无漏译」 */
export const MESSAGES = api.MESSAGES;
export const LOCALES = api.LOCALES;
export const DEFAULT_LOCALE = api.DEFAULT_LOCALE;

/**
 * 按设置项切换界面语言。
 * settings.language 缺省（老版本存下来的设置）时按「跟随浏览器」处理。
 */
export function applyLanguageSetting(settings) {
  return setLocale(settings?.language || 'auto');
}
