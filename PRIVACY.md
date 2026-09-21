# 隐私政策 · AI 阅读助手（划词即问）

最后更新：2026-09-21　·　适用版本：1.6.0 及以后

本扩展（Chrome / Edge，名称「AI 阅读助手 · 划词即问」，以下简称"本扩展"）由个人开发者提供。
本文说明本扩展会处理哪些数据、怎么处理、以及你可以怎么控制它。

**一句话概括：本扩展没有自己的服务器。你选中的文字只会发送到你自己配置的模型服务商；
只有你主动点「导出」时，那条内容才会交给你自己配置的笔记服务（Notion 或本机 Obsidian）。
问答记录只存在你自己的浏览器里，开发者拿不到任何数据。**

可选功能「页面上下文」默认**关闭**。只有你亲手打开它之后，当前页面的正文才会随提问一起发送
（详见第 1.1 节）—— 默认状态下，页面正文不会离开你的浏览器。

---

## 1. 本扩展处理哪些数据

| 数据 | 何时产生 | 存放在哪 | 发给谁 |
|---|---|---|---|
| 选中的文字、所在段落、页面标题与网址 | 只有你**主动划词并触发提问**时 | 仅在你本机（用于本地问答记录） | 仅发送到**你自己在设置里填写的模型服务商** |
| 当前页面正文（**可选，默认关闭**） | 只有你开启设置页的「页面上下文」后，**每次提问时** | 仅在你本机（用于本地问答记录） | 同上。详见第 1.1 节 |
| 你输入的追问问题 | 同上 | 同上 | 同上 |
| 模型返回的回答 | 提问之后 | 同上 | 不发送（除非你主动导出，见下行） |
| 你主动导出的那条问答（含选中内容与回答） | 只有你**点击「导出」并选定目标**时 | 不额外留存 | 仅发送到你自己配置的笔记服务：Notion（你的集成令牌）或本机 Obsidian |
| API Key、接口地址、模型名等设置 | 你在设置页保存时 | 仅在你本机浏览器扩展存储中（`chrome.storage.local`，明文） | 不发送给任何第三方；仅用于向你配置的服务商发起请求 |
| Notion 集成令牌、父页面 ID | 你在设置页保存时 | 同上，仅在本机 | 仅用于向你自己的 Notion 集成发起写入请求 |
| 站点黑名单、面板宽度等偏好 | 你调整设置时 | 仅在你本机 | 不发送 |

本扩展**不会**收集：你的浏览历史、其他标签页内容、表单输入、剪贴板、账号密码、位置、
设备标识符或任何用于广告投放的标识。

**不提问就不会有任何内容离开你的浏览器。** 本扩展不会在后台自动读取或上传任何页面内容。

### 1.1 「页面上下文」：一个默认关闭的可选功能

划词问答默认只用「你选中的文字 + 它所在的那一段」。这在读长文档时常常不够用 ——
问「上面提到的那个概念是什么」，答案可能在上一节里。为此本扩展提供了一个可选项：

| 档位 | 行为 | 默认 |
|---|---|---|
| 仅所在段落 | 只发送选中内容与所在段落（**页面正文不外发**） | ✅ 出厂默认 |
| 所在段落不足时自动补整页 | 仅当所在段落太短（不足 200 字）时，才额外发送正文 | — |
| 总是带上整页正文 | 每次提问都额外发送当前页面正文（最多 8000 字） | — |

开启后请注意：

- **它一定是你在设置页里主动选择的**，出厂默认为关闭，本扩展不会替你打开。
- 采集**只在你提问的那一刻发生**，且只取当前这一个标签页、当前这一个页面 ——
  不读取其他标签页、不读取浏览器历史、不做后台预采集或定时上传。
- 发送范围**受页面结构限制**：本扩展会主动剔除导航栏、侧边栏、页脚、评论区等噪音，
  取的是页面正文，并把长度截断到上限（超出部分不会发送，界面上会明确提示已截断）。
- 正文内容会随该次提问一起发送到**你在设置里配置的那个模型服务商**，
  并和选中内容一样被写入本地问答记录（可在设置页删除或清空）。
- 想停止：把该档位改回「仅所在段落」即可，之后页面正文不再随请求发送。

## 2. 数据发送给谁

本扩展本身不含任何中转服务器，也不与开发者的任何服务端通信。当你提问时，请求从你的浏览器
**直接**发往你在设置页中配置的接口地址（Base URL）与模型。该服务商如何处置这些数据，
取决于你与它之间的服务条款与隐私政策，常见服务商包括：

- DeepSeek（深度求索）· Moonshot / Kimi（月之暗面）· 阿里云百炼（通义）· 智谱 AI · 硅基流动
- OpenAI · Anthropic · 以及任何你自行填写的 OpenAI 兼容接口
- 你本机运行的 Ollama / LM Studio 等本地模型（此时数据不出本机）

请在使用前阅读你所用服务商的隐私政策。**开发者无法访问、也无权访问这些请求内容。**

### 导出到笔记平台（可选功能，默认不启用）

只有你在设置页自行配置之后，导出入口才会真正往外部写入，且**每次都由你点击触发**，
不存在后台自动同步：

- **Notion**：内容通过 Notion 官方 API 写入你指定的父页面。使用的是你自己创建的集成令牌，
  数据直接进入你自己的 Notion 工作区，同样不经过开发者的服务器。
- **Obsidian**：通过 `obsidian://` 协议交给**你本机安装的** Obsidian 应用，内容不出本机、不经网络。
- **导出为 Markdown 文件**：由浏览器下载到你的本地磁盘。

未配置任何笔记服务时，导出功能不会触达任何外部地址。

## 3. 数据存储与保留

- 所有设置与问答记录均保存在浏览器扩展的本地存储中，**不随浏览器账号同步到其他设备**。
- 问答记录默认自动存档，你可以在设置页随时关闭自动存档、逐条删除、一键清空或导出为
  Markdown；卸载扩展即删除全部本地数据。
- 记录条数上限可配置，超出后自动淘汰最旧的记录（被收藏的记录不淘汰）。
- 除你本机浏览器存储与发往你所配置模型服务的请求外，本扩展不向任何位置写入数据。

## 4. 权限用途说明

| 权限 | 用途 |
|---|---|
| `storage` / `unlimitedStorage` | 在本机保存设置与问答记录 |
| `contextMenus` | 提供右键「解释 / 翻译 / 追问」菜单 |
| `downloads` | 导出 Markdown 记录时触发保存对话框 |
| 内容脚本访问网页 | 默认只读取你**选中的那一段文字**及所在段落；只有你在设置页开启「页面上下文」之后，才会额外读取当前页面的正文。两种情况都**只在你提问的那一刻**读取，不做后台采集、不读取其他标签页 |
| 站点权限（按需申请） | 仅向你在设置里填写的那个接口域名申请联网权限，不申请全站访问权 |
| `api.notion.com`（可选，按需申请） | **仅在你点击「连接 Notion 并测试」时申请**，用于把问答写入你自己的 Notion。不配置 Notion 就完全不会申请，也不会发起任何相关请求 |

本扩展**不加载任何远程代码**，所有逻辑都包含在安装包内。

## 5. 你的权利与控制

- 查看 / 导出：设置页「历史记录」标签可查看、搜索、导出全部记录。
- 删除：可逐条删除、清空（可选择保留收藏）、或卸载扩展。
- 停止上传：清空设置里的 API Key，或将某个站点加入黑名单（该站点不再出现划词界面）。
- 停止发送页面正文：设置页「页面上下文」改回「仅所在段落」（出厂默认即是这一档）。
- 关闭记录：设置页关闭「自动存档每次问答」。
- 停止导出：清空设置页「笔记集成」里的 Notion 令牌与父页面即彻底关闭该通路；
  Obsidian 与文件导出本就只在你点击时发生。

## 6. 儿童

本扩展不面向 13 岁以下儿童，也不会有意收集其数据。

## 7. 政策变更

本政策如有更新，会随新版本一并提交至扩展商店，并更新本文顶部的"最后更新"日期。

## 8. 联系方式

有任何隐私相关问题，请在本项目仓库提 Issue：
<https://github.com/crossSulation/ai-reader/issues>

---

# Privacy Policy (English)

Last updated: 2026-09-21. Applies to version 1.6.0 and later.

**Summary: this extension has no backend. The text you select is sent only to the model
provider you configure yourself, and your Q&A history stays in your own browser.**

The optional "Page context" feature is **off by default**. Only after you turn it on does the
current page's text travel with your question (see "Page context" below). In the default
state, page text never leaves your browser.

**Data processed.** Only when you explicitly select text and ask a question, the extension
reads the selected text, its surrounding paragraph, and the page title/URL, and sends them
directly from your browser to the model provider you configured. Your API key, endpoint and
other settings are stored in your browser's local extension storage (`chrome.storage.local`)
and are never sent anywhere except to your configured provider as an authentication header.
Q&A records are stored locally only.

**Page context (optional, off by default).** When you switch this setting to
"always include the full page text" (or to the "auto" fallback), the extension also reads the
main text of the current page — navigation, sidebars, footers and comment sections are
stripped out, and the length is capped (8,000 characters). This happens **only at the moment
you ask a question**, only for the current tab, and the extracted text is sent to the same
model provider you configured. The default setting is "paragraph only", in which case no page
text is sent. Switch it back at any time to stop.

**What we do not collect.** No browsing history, no other tabs' content, no form inputs,
no clipboard, no credentials, no location, no device identifiers, no advertising data.
Nothing leaves your browser unless you trigger a question.

**No remote code.** All code is bundled in the package; the extension loads nothing remotely.

**No developer server.** The developer receives no data and cannot access your requests.

**Your control.** You can view, export, delete or clear all records in the extension's
settings page; disable auto-save; remove your API key; blacklist sites; or uninstall the
extension to delete all local data.

**Third parties.** Requests go to the provider you choose (e.g. DeepSeek, Moonshot/Kimi,
OpenAI, Anthropic, a local Ollama/LM Studio server, or any OpenAI-compatible endpoint).
Their handling of the data is governed by their own privacy policies.

**Contact.** Open an issue at <https://github.com/crossSulation/ai-reader/issues>.
