// paths.mjs — 本地托盘版的路径常量（唯一来源，全部由脚本自身位置推导）
//
// 设计约束：
//   · 程序目录可以整体搬到另一台机器/另一个盘符，所有路径都从 import.meta.url 解析，
//     不硬编码任何开发者机器上的绝对路径。
//   · local/ 下除源码外都是「本机运行数据」（config.json / state.json / logs / cache / 用户图标），
//     已在 .gitignore 中排除，不能提交到仓库。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../scripts/auto-sync/local/modules

/**
 * local/ 目录（脚本目录，可整体搬迁）。
 * 允许用环境变量 FDN_LOCAL_DIR 把「本机运行数据」重定向到别处——只用于自动化测试/联调，
 * 正常运行时不需要设置它（仓库根目录仍按源码真实位置推导，不受它影响）。
 */
export const LOCAL_DIR = process.env.FDN_LOCAL_DIR
  ? path.resolve(process.env.FDN_LOCAL_DIR)
  : path.resolve(HERE, '..');
/**
 * 仓库根目录（modules → local → auto-sync → scripts → 仓库根）。
 * FDN_REPO_ROOT 仅供自动化测试把整个流程指向临时仓库，正常运行时不要设置。
 */
export const REPO_ROOT = process.env.FDN_REPO_ROOT
  ? path.resolve(process.env.FDN_REPO_ROOT)
  : path.resolve(HERE, '..', '..', '..', '..');

export const CONFIG_FILE = path.join(LOCAL_DIR, 'config.json');
export const STATE_FILE = path.join(LOCAL_DIR, 'state.json');
export const LOCK_FILE = path.join(LOCAL_DIR, 'state', 'instance.lock');
export const STATE_DIR = path.join(LOCAL_DIR, 'state');
export const LOG_DIR = path.join(LOCAL_DIR, 'logs');
export const ASSETS_DIR = path.join(LOCAL_DIR, 'assets');
export const CACHE_DIR = path.join(LOCAL_DIR, 'cache', 'icons');
export const DEFAULT_ICON = path.join(ASSETS_DIR, 'default.ico');

/** 共享同步业务入口（与 GHA 同一份实现） */
export const SYNC_SCRIPT = path.join(REPO_ROOT, 'scripts', 'auto-sync', 'sync.mjs');
/** 本机数据落盘目录（Git 提交的范围） */
export const DATA_DIR = path.join(REPO_ROOT, 'data', 'down');

export const TRAY_PS1 = path.join(LOCAL_DIR, 'tray.ps1');
export const ICON_COMPOSE_PS1 = path.join(LOCAL_DIR, 'icon-compose.ps1');
