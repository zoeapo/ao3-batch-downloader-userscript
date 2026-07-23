# AO3 TXT 批量作品下载器

这是一个适用于 Chrome 和 Tampermonkey 的油猴脚本。

它从本地 TXT 文件读取 AO3 作品网址，自动清洗链接、去重，并批量下载 AO3 官方提供的 EPUB 和 PDF。

## 当前版本

v0.3.0

## 主要功能

- 导入包含大量 AO3 作品网址的 TXT 文件
- 支持章节链接、带参数链接和带锚点链接
- 自动统一为 `https://archiveofourown.org/works/作品编号`
- 自动去重
- 分别下载 EPUB 和 PDF
- 保留 AO3 官方下载文件名
- 可选择本地保存文件夹
- 同名文件自动加 `(1)`、`(2)` 等编号
- 作品间隔、格式间隔、失败重试间隔均可设置为随机范围
- 下载记录和按格式去重
- 页面刷新后恢复上次导入队列
- 暂停、继续和停止任务
- 导出清洗后的链接、失败链接、无效行和完整记录
- 遇到 AO3 HTTP 429 时遵守服务器给出的等待时间
- 使用当前浏览器中的 AO3 登录状态

## 安装

1. 在 Chrome 中安装 Tampermonkey。
2. 打开 `ao3-txt-batch-downloader.user.js`。
3. Tampermonkey 出现安装页面后点击安装。
4. 打开任意 AO3 页面。
5. 页面右下角会出现“TXT 批量下载”按钮。

仓库上传完成后，也可以通过以下地址安装：

```text
https://raw.githubusercontent.com/zoeapo/ao3-batch-downloader-userscript/main/ao3-txt-batch-downloader.user.js
```

## 使用方法

1. 打开任意 AO3 页面。
2. 点击右下角“TXT 批量下载”。
3. 点击“选择 TXT”，导入网址文件。
4. 检查识别数量、重复数量和无法识别数量。
5. 选择 EPUB、PDF 或两者。
6. 按需设置随机间隔。
7. 需要指定保存位置时，点击“选择保存文件夹”。
8. 勾选“保存到所选文件夹”。
9. 点击“开始”。

## 选择保存文件夹

v0.3.0 增加了文件夹选择功能。

点击“选择保存文件夹”后，Chrome 会显示文件夹选择窗口。授权后，EPUB 和 PDF 会直接写入该文件夹，不再使用浏览器默认下载目录。

脚本会把文件夹句柄保存在浏览器的 IndexedDB 中。刷新页面后可能需要重新授权。点击“重新授权或更换文件夹”即可。

如果取消勾选“保存到所选文件夹”，脚本会继续使用普通浏览器下载方式。

文件夹模式目前以 Chrome 为主要支持环境。其他浏览器可能无法使用目录选择功能，但普通下载仍可使用。

## 随机间隔

默认值：

- 作品间隔：10 至 15 秒
- 格式间隔：1 至 3 秒
- 失败重试间隔：5 至 15 秒
- 失败重试次数：2 次

每次等待都会重新随机取一个整数。例如作品间隔设为 10 至 15 秒，实际可能依次等待 13、10、15、12 秒。

随机间隔不能保证不会触发 AO3 限流。出现 HTTP 429 时，脚本会按 AO3 返回的 `Retry-After` 时间暂停。

## TXT 支持格式

以下链接都会被识别：

```text
https://archiveofourown.org/works/87836186
https://archiveofourown.org/works/87836186/chapters/123456
https://archiveofourown.org/works/87836186/chapters/123456#workskin
https://archiveofourown.org/works/87836186#main
https://archiveofourown.org/works/87836186?view_full_work=true#main
https://archiveofourown.org/works/87836186?__cf_chl_f_tk=xxxx
```

统一结果：

```text
https://archiveofourown.org/works/87836186
```

每行可以有一个链接，也可以包含其他文字。脚本会提取其中的作品编号。

## 下载记录

记录单位为“作品编号 + 文件格式”。

例如 EPUB 下载成功、PDF 下载失败，下次运行时可以跳过 EPUB，只重试 PDF。

点击“清空下载记录”后，脚本会重新下载曾经成功的文件。

## 文件名冲突

使用所选文件夹时，脚本不会覆盖现有文件。

例如文件夹里已有：

```text
example.epub
```

新文件会保存为：

```text
example (1).epub
```

## EPUB 下载问题

普通下载模式下，如果 Tampermonkey 返回 `not_whitelisted`，脚本会改用二进制读取和浏览器下载。

文件夹模式直接读取文件并写入所选目录，不受 Tampermonkey 扩展名白名单限制。

## 更新

安装脚本后，Tampermonkey 会根据脚本头部的 `@updateURL` 检查更新。

发布新版本时需要同时更新：

- `ao3-txt-batch-downloader.user.js`
- `dist/ao3-txt-batch-downloader-v版本号.user.js`
- 脚本头部 `@version`
- `CHANGELOG.md`
- `package.json`

## 项目结构

```text
ao3-batch-downloader-userscript/
├─ ao3-txt-batch-downloader.user.js
├─ dist/
│  └─ ao3-txt-batch-downloader-v0.3.0.user.js
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ PRIVACY.md
│  └─ TESTING.md
├─ scripts/
│  └─ check.mjs
├─ .github/
│  ├─ ISSUE_TEMPLATE/
│  └─ pull_request_template.md
├─ CHANGELOG.md
├─ CONTRIBUTING.md
├─ LICENSE
├─ NOTICE.md
├─ package.json
└─ README.md
```

## 本地检查

需要 Node.js。

```bash
npm run check
```

检查内容包括：

- JavaScript 语法
- userscript 元数据
- 版本号一致性
- GitHub 更新地址
- 关键功能函数是否存在

## 隐私

脚本只把请求发送给 AO3 相关域名。TXT 文件、下载记录和文件夹句柄保存在本地浏览器中。

详细说明见 `docs/PRIVACY.md`。

## 许可证

GPL-3.0-only。

## 致谢

功能设计参考了：

- `nianeyna/ao3downloader`

本项目是浏览器端独立重写，与 Archive of Our Own、OTW 和原项目作者没有隶属关系。
