'use strict';

/**
 * 生成 Windows 便携版（免安装）：把 electron dist 复制出来、改名为
 * "DeepSeek Harness.exe"，应用本体放在 resources/app（未压缩目录）。
 * 双击 exe 即可运行，无需 node / npm / 浏览器。
 *
 * 产物：dist/DeepSeek Harness-win32-x64/
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const outDir = path.join(root, 'dist', 'DeepSeek Harness-win32-x64');
const appDir = path.join(outDir, 'resources', 'app');

if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
  console.error('未找到 electron dist，请先执行 npm install');
  process.exit(1);
}

// 1) 复制 electron 运行环境（去掉 default_app.asar）
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });
fs.cpSync(electronDist, outDir, {
  recursive: true,
  filter: (src) => !src.endsWith('default_app.asar'),
});

// 2) 主程序改名
const oldExe = path.join(outDir, 'electron.exe');
const newExe = path.join(outDir, 'DeepSeek Harness.exe');
if (fs.existsSync(oldExe)) {
  fs.renameSync(oldExe, newExe);
} else {
  console.error('electron.exe 不存在，打包失败');
  process.exit(1);
}

// 3) 应用本体
for (const item of ['package.json', 'src', 'assets']) {
  const from = path.join(root, item);
  if (fs.existsSync(from)) {
    fs.cpSync(from, path.join(appDir, item), { recursive: true });
  }
}

// 4) 生产依赖（排除 electron 自身及其包装目录）
const srcModules = path.join(root, 'node_modules');
const dstModules = path.join(appDir, 'node_modules');
fs.mkdirSync(dstModules, { recursive: true });
fs.cpSync(srcModules, dstModules, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(srcModules, src);
    const top = rel.split(path.sep)[0];
    if (!top) return true;
    if (top === 'electron' || top === '.bin' || top.startsWith('electron-')) return false;
    return true;
  },
});

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

const bytes = dirSize(outDir);
console.log(`打包完成: ${outDir}`);
console.log(`体积: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`启动方式: 双击 "DeepSeek Harness.exe"`);
