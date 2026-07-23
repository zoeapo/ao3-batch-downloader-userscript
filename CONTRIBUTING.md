# 参与开发

## 提交问题

提交 Bug 时请提供：

- Chrome 版本
- Tampermonkey 版本
- 脚本版本
- 是否登录 AO3
- 是否使用所选文件夹模式
- 面板日志
- 可以公开的示例链接

请删除日志中的私人信息。

## 修改代码

1. Fork 仓库。
2. 新建分支。
3. 修改根目录的 `ao3-txt-batch-downloader.user.js`。
4. 同步修改 `dist` 中的版本文件。
5. 更新版本号和 `CHANGELOG.md`。
6. 运行：

```bash
npm run check
```

7. 提交 Pull Request。

## 代码要求

- 保持中文界面
- 不保存 AO3 用户密码
- 不绕过 AO3 权限或访问控制
- 遵守 AO3 返回的 429 等待时间
- 不增加高并发下载
- 不覆盖用户已有文件
