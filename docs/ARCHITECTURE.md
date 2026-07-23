# 结构说明

## 输入

用户从本地选择 TXT 文件。脚本逐行提取 AO3 作品编号，并统一为标准作品网址。

## 队列

队列和无效行通过 Tampermonkey 的 `GM_setValue` 保存。页面刷新后可以恢复。

## 请求

脚本使用 `GM_xmlhttpRequest` 读取作品页，从 AO3 官方 Download 菜单提取 EPUB 和 PDF 地址。

请求串行执行，不使用并发下载。

## 普通下载模式

优先使用 `GM_download`。

EPUB 被 Tampermonkey 扩展名白名单拦截时，改用 `GM_xmlhttpRequest` 读取 Blob，再由浏览器下载。

## 文件夹模式

1. 用户点击按钮调用 `showDirectoryPicker()`。
2. 目录句柄保存在 IndexedDB。
3. 下载文件通过 `GM_xmlhttpRequest` 读取为 Blob。
4. 使用 `FileSystemDirectoryHandle.getFileHandle()` 创建文件。
5. 使用 `FileSystemFileHandle.createWritable()` 写入内容。
6. 同名文件使用自动编号。

## 记录

下载记录按作品编号和格式分别保存。记录内容包括状态、文件名、下载地址、下载方式和时间。

## 限流

作品间隔、格式间隔和失败重试间隔均为用户设置范围内的随机整数。

AO3 返回 HTTP 429 时，以 `Retry-After` 为准。
