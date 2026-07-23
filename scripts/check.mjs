import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const scriptPath = path.join(root, 'ao3-txt-batch-downloader.user.js');
const packagePath = path.join(root, 'package.json');

const script = fs.readFileSync(scriptPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

const failures = [];

const syntax = spawnSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' });
if (syntax.status !== 0) {
  failures.push(`JavaScript 语法检查失败：\n${syntax.stderr || syntax.stdout}`);
}

function requireText(label, value) {
  if (!script.includes(value)) failures.push(`缺少 ${label}：${value}`);
}

requireText('userscript 名称', '// @name         AO3 TXT 批量作品下载器');
requireText('版本号', `// @version      ${pkg.version}`);
requireText('许可证', '// @license      GPL-3.0-only');
requireText('更新地址', '// @updateURL    https://raw.githubusercontent.com/zoeapo/ao3-batch-downloader-userscript/main/ao3-txt-batch-downloader.user.js');
requireText('目录选择功能', 'showDirectoryPicker');
requireText('IndexedDB 目录句柄存储', 'storeDirectoryHandle');
requireText('随机等待功能', 'randomDelaySeconds');
requireText('EPUB 备用下载', 'not_whitelisted');
requireText('AO3 限流处理', 'response.status === 429');

const distPath = path.join(root, 'dist', `ao3-txt-batch-downloader-v${pkg.version}.user.js`);
if (!fs.existsSync(distPath)) {
  failures.push(`缺少发布文件：${path.relative(root, distPath)}`);
} else {
  const dist = fs.readFileSync(distPath, 'utf8');
  if (dist !== script) failures.push('根目录脚本和 dist 发布脚本内容不一致');
}

if (failures.length) {
  console.error(failures.map((item) => `- ${item}`).join('\n'));
  process.exit(1);
}

console.log(`检查通过：AO3 TXT 批量作品下载器 v${pkg.version}`);
