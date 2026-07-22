# AO3 TXT 批量作品下载器

这个版本以 TXT 文件为输入。TXT 中可以有近千条 AO3 作品网址，每行一条最清楚，也允许一行中夹有其他文字。

## 功能

- 导入本地 TXT
- 自动识别 `/works/数字`，并清除章节路径、查询参数和锚点
- 自动去重
- 导出清洗后的标准网址 TXT
- 分别下载 AO3 官方 EPUB 和 PDF
- 沿用 AO3 官方下载文件名
- 保存下载记录，重新运行时跳过已成功的格式
- 暂停、继续、停止
- 导出失败网址和完整 JSON 记录
- 识别 AO3 的 429 限流并等待
- 使用浏览器已有的 AO3 登录状态读取受限作品

## 支持的输入示例

以下网址都会统一成 `https://archiveofourown.org/works/87836186`：

```text
https://archiveofourown.org/works/87836186
https://archiveofourown.org/works/87836186/chapters/123456
https://archiveofourown.org/works/87836186/chapters/123456#workskin
https://archiveofourown.org/works/87836186#main
https://archiveofourown.org/works/87836186?view_full_work=true#main
https://archiveofourown.org/works/87836186?__cf_chl_f_tk=example
```

## 安装

1. Chrome 安装 Tampermonkey。
2. 打开 `ao3-txt-batch-downloader.user.js`。
3. Tampermonkey 会显示安装页，点击安装。
4. 打开任意 AO3 页面。
5. 点击右下角“TXT 批量下载”。

## 使用

1. 导入 TXT。
2. 检查识别数量、重复数量和无法识别数量。
3. 需要时先导出“清洗后链接”。
4. 选择 EPUB、PDF。
5. 建议第一次只用少量网址测试。
6. 点击“开始”。

Chrome 可能询问是否允许该站点下载多个文件，需要选择允许。下载近千部作品会持续很久，建议保持 AO3 页面和浏览器开启。

## 续传

脚本保存两类本地数据：

- 最近一次导入的作品队列
- 每个作品、每种格式的成功或失败记录

页面刷新后，队列会恢复。勾选“跳过已成功下载”后重新开始，就会跳过已经完成的 EPUB 或 PDF。

## 已知限制

- 浏览器不能确认磁盘中的文件是否后来被手动删除。去重依据脚本记录。
- Chrome 的多文件下载权限可能阻止批量任务。
- AO3 页面结构改变后，下载链接解析可能需要更新。
- 真实下载需要在 Chrome、Tampermonkey 和 AO3 环境中测试。

## 许可证

GPL-3.0-only。
