# 发布步骤

1. 修改根目录脚本中的 `@version` 和 `APP_VERSION`。
2. 修改 `package.json` 中的版本号。
3. 复制根目录脚本到：

```text
dist/ao3-txt-batch-downloader-v版本号.user.js
```

4. 更新 `CHANGELOG.md`。
5. 运行：

```bash
npm run check
```

6. 提交到 `main` 分支。
7. 创建 GitHub Release。
8. 把 `dist` 中的版本文件附加到 Release。
9. 确认 Raw 地址可以打开并触发 Tampermonkey 安装。
