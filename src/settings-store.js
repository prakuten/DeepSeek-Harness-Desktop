'use strict';

/**
 * 设置存储：userData/settings.json。
 * 结构扁平、带默认值合并，损坏时回退默认值。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  reuseExisting: true, // 检测并复用 127.0.0.1:3080 上已运行的 DSH 实例
  closeBehavior: 'tray', // 'tray'（关闭到托盘）| 'quit'（直接退出）
  autoLaunch: false, // 开机自启
  notifications: true, // 系统通知
  portStart: 3080, // 自起后端的起始端口（向后探测 40 个）
};

function settingsPath(userData) {
  return path.join(userData, 'settings.json');
}

function load(userData) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(userData), 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(userData, settings) {
  const merged = { ...DEFAULTS, ...settings };
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(settingsPath(userData), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = { DEFAULTS, load, save, settingsPath };
