# 隐私政策 · AI 阅读助手（划词即问）

最后更新：2026-09-18　·　适用版本：1.3.0 及以后

本扩展（Chrome / Edge，名称「AI 阅读助手 · 划词即问」，以下简称"本扩展"）由个人开发者提供。
本文说明本扩展会处理哪些数据、怎么处理、以及你可以怎么控制它。

**一句话概括：本扩展没有自己的服务器。你选中的文字只会发送到你自己配置的模型服务商；
只有你主动点「导出」时，那条内容才会交给你自己配置的笔记服务（Notion 或本机 Obsidian）。
问答记录只存在你自己的浏览器里，开发者拿不到任何数据。**

---

## 1. 本扩展处理哪些数据

| 数据 | 何时产生 | 存放在哪 | 发给谁 |
|---|---|---|---|
| 选中的文字、所在段落、页面标题与网址 | 只有你**主动划词并触发提问**时 | 仅在你本机（用于本地问答记录） | 仅发送到**你自己在设置里填写的模型服务商** |
| 你输入的追问问题 | 同上 | 同上 | 同上 |
| 模型返回的回答 | 提问之后 | 同上 | 不发送（除非你主动导出，见下行） |
| 你主动导出的那条问答（含选中内容与回答） | 只有你**点击「导出」并选定目标**时 | 不额外留存 | 仅发送到你自己配置的笔记服务：Notion（你的集成令牌）或本机 Obsidian |
| API Key、接口地址、模型名等设置 | 你在设置页保存时 | 仅在你本机浏览器扩展存储中（`chrome.storage.local`，明文） | 不发送给任何第三方；仅用于向你配置的服务商发起请求 |
| Notion 集成令牌、父页面 ID | 你在设置页保存时 | 同上，仅在本机 | 仅用于向你自己的 Notion 集成发起写入请求 |
| 站点黑名单、面板宽度等偏好 | 你调整设置时 | 仅在你本机 | 不发送 |

本扩展**不会**收集：你的浏览历史、其他标签页内容、表单输入、剪贴板、账号密码、位置、
设备标识符或任何用于广告投放的标识。

**不提问就不会有任何内容离开你的浏览器。** 本扩展不会在后台自动读取或上传任何页面内容。

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
| 内容脚本访问网页 | 读取你**选中的那一段文字**及所在段落，用于提问；不读取页面其他内容 |
| 站点权限（按需申请） | 仅向你在设置里填写的那个接口域名申请联网权限，不申请全站访问权 |
| `api.notion.com`（可选，按需申请） | **仅在你点击「连接 Notion 并测试」时申请**，用于把问答写入你自己的 Notion。不配置 Notion 就完全不会申请，也不会发起任何相关请求 |

本扩展**不加载任何远程代码**，所有逻辑都包含在安装包内。

## 5. 你的权利与控制

- 查看 / 导出：设置页「历史记录」标签可查看、搜索、导出全部记录。
- 删除：可逐条删除、清空（可选择保留收藏）、或卸载扩展。
- 停止上传：清空设置里的 API Key，或将某个站点加入黑名单（该站点不再出现划词界面）。
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

Last updated: 2026-09-18. Applies to version 1.3.0 and later.

**Summary: this extension has no backend. The text you select is sent only to the model
provider you configure yourself, and your Q&A history stays in your own browser.**

**Data processed.** Only when you explicitly select text and ask a question, the extension
reads the selected text, its surrounding paragraph, and the page title/URL, and sends them
directly from your browser to the model provider you configured. Your API key, endpoint and
other settings are stored in your browser's local extension storage (`chrome.storage.local`)
and are never sent anywhere except to your configured provider as an authentication header.
Q&A records are stored locally only.

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
