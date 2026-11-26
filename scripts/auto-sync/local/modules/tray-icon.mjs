// tray-icon.mjs — 托盘图标：角标状态决策、缓存键、GDI+ 合成调度、ICO 打包
//
// 设计 §6：
//   · 角标优先级：同步中 > 暂停 > 最近结果（成功/已是最新/失败/内部错误）> 无
//   · 底图与角标分开处理；角标在右下角、约 50%；透明挖空沿角标实际轮廓；抗锯齿；多尺寸（DPI）
//   · 缓存键至少包含：底图哈希 + 角标类型 + 输出尺寸集合
//   · 状态变化时优先读缓存，避免重复合成
//
// 分工：Node 负责决策/缓存/ICO 打包；像素绘制交给 PowerShell + System.Drawing（icon-compose.ps1），
// 避免在 Node 里手写 PNG/ICO 解码器或引入第三方图片库（设计 §22：不无故增加依赖）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { ASSETS_DIR, CACHE_DIR, DEFAULT_ICON, ICON_COMPOSE_PS1, LOCAL_DIR } from './paths.mjs';

/** 多尺寸输出（覆盖 100%–200% 缩放下的常见 DPI） */
export const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64];

/**
 * 根据运行状态决定角标。
 * @param {{running:boolean, paused:boolean, lastRun:{status:string}|null, hasRun?:boolean}} view
 */
export function decideBadge(view) {
  if (!view) return 'none';
  if (view.running) return 'running';
  if (view.paused) return 'paused';
  const status = view.lastRun && view.lastRun.status;
  if (status === 'success') return 'success';
  if (status === 'up-to-date') return 'up-to-date';
  if (status === 'failure' || status === 'internal-error') return 'failure';
  return 'none';
}

function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** 缓存文件名：底图哈希 + 角标 + 尺寸集合 */
export function cacheKey(baseHash, badge, sizes = ICON_SIZES) {
  return crypto.createHash('sha256')
    .update(`${baseHash || 'default'}|${badge}|${sizes.join(',')}`)
    .digest('hex')
    .slice(0, 16);
}

/** 读 PNG 的宽高（IHDR：偏移 16 起 4 字节宽、4 字节高，大端） */
export function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  const sigOk = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!sigOk) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * 把若干 PNG 打成多尺寸 .ico（Windows 支持 PNG 内嵌条目）。
 * @param {Array<{size:number, data:Buffer}>} images 按尺寸升序
 */
export function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type = icon
  header.writeUInt16LE(count, 4);

  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  images.forEach((img, i) => {
    const dim = pngSize(img.data);
    const width = dim ? dim.width : img.size;
    const height = dim ? dim.height : img.size;
    const base = i * 16;
    entries.writeUInt8(width >= 256 ? 0 : width, base + 0);
    entries.writeUInt8(height >= 256 ? 0 : height, base + 1);
    entries.writeUInt8(0, base + 2);          // color count
    entries.writeUInt8(0, base + 3);          // reserved
    entries.writeUInt16LE(1, base + 4);       // planes
    entries.writeUInt16LE(32, base + 6);      // bit count
    entries.writeUInt32LE(img.data.length, base + 8);
    entries.writeUInt32LE(offset, base + 12);
    offset += img.data.length;
  });

  return Buffer.concat([header, entries, ...images.map((img) => img.data)]);
}

/** 调用 icon-compose.ps1 渲染各尺寸 PNG 到临时目录 */
function composeWithPowerShell({ basePath, badge, outDir, sizes, outIco }) {
  const psExe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', ICON_COMPOSE_PS1,
    '-Base', basePath,
    '-Badge', badge,
    '-OutDir', outDir,
    '-Sizes', sizes.join(','),
  ];
  if (outIco) args.push('-OutIco', outIco);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(psExe, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, error: e && e.message ? e.message : String(e) });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
    }, 60000);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e && e.message ? e.message : String(e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, error: code === 0 ? null : (err.trim() || `icon-compose.ps1 退出码 ${code}`), stdout: out, stderr: err });
    });
  });
}

/**
 * 确保有一个可用的图标文件。
 *
 * @param {object} opts
 * @param {object} opts.config 配置（读 appearance.iconPath）
 * @param {object} opts.view {running, paused, lastRun}
 * @param {object} [opts.log]
 * @param {boolean} [opts.force] 忽略缓存（例如用户刚换了图片）
 * @returns {Promise<{path:string, badge:string, cached:boolean, error:string|null}>}
 */
export async function ensureIcon({ config, view, log = { info: () => {}, warn: () => {} }, force = false }) {
  const badge = decideBadge(view);
  const configured = (config.appearance || {}).iconPath;

  // 底图选择：用户自定义（存在且可读）→ 默认底图
  // 自定义图标存的是相对 local/ 的路径（如 assets/user-icon.png），程序目录搬走后仍然有效
  const configuredAbs = configured
    ? (path.isAbsolute(configured) ? configured : path.join(LOCAL_DIR, configured))
    : '';
  let basePath = DEFAULT_ICON;
  let baseNote = 'default';
  if (configuredAbs && fs.existsSync(configuredAbs)) {
    basePath = configuredAbs;
    baseNote = 'custom';
  } else if (configured) {
    log.warn('Icon', `自定义图标不存在，回退默认底图：${configured}`);
  }

  if (!fs.existsSync(basePath)) {
    log.warn('Icon', `底图不存在：${basePath}`);
    return { path: fs.existsSync(DEFAULT_ICON) ? DEFAULT_ICON : '', badge, cached: false, error: '缺少底图文件' };
  }

  const baseHash = sha256File(basePath);
  if (!baseHash) {
    return { path: DEFAULT_ICON, badge, cached: false, error: '无法读取底图' };
  }

  const key = cacheKey(`${baseHash}-${baseNote}`, badge, ICON_SIZES);
  const cachePath = path.join(CACHE_DIR, `${key}.ico`);

  if (!force && fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
    return { path: cachePath, badge, cached: true, error: null };
  }

  // 缓存未命中 → 合成
  const tmpDir = path.join(CACHE_DIR, `.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const composedIco = path.join(tmpDir, 'tray.ico');
    const composed = await composeWithPowerShell({ basePath, badge, outDir: tmpDir, sizes: ICON_SIZES, outIco: composedIco });
    if (!composed.ok) {
      log.warn('Icon', `图标合成失败：${composed.error}`);
      if (fs.existsSync(cachePath)) return { path: cachePath, badge, cached: true, error: composed.error };
      return { path: fs.existsSync(DEFAULT_ICON) ? DEFAULT_ICON : '', badge, cached: false, error: composed.error };
    }

    // 首选：icon-compose.ps1 直接产出的多尺寸 DIB ICO（System.Drawing.Icon 能直接读）
    let ico = null;
    if (fs.existsSync(composedIco) && fs.statSync(composedIco).size > 0) ico = fs.readFileSync(composedIco);

    // 兜底：用逐尺寸 PNG 自己打包（PNG 帧 ICO；.NET 的 Icon 读不了，但 Windows 外壳能读）
    if (!ico) {
      const images = [];
      for (const size of ICON_SIZES) {
        const file = path.join(tmpDir, `icon-${size}.png`);
        if (!fs.existsSync(file)) continue;
        const data = fs.readFileSync(file);
        if (data.length) images.push({ size, data });
      }
      if (!images.length) {
        log.warn('Icon', '图标合成未产出任何图标数据');
        return { path: fs.existsSync(DEFAULT_ICON) ? DEFAULT_ICON : '', badge, cached: false, error: '合成无输出' };
      }
      ico = buildIco(images);
      log.warn('Icon', 'icon-compose.ps1 未产出 .ico，已用 PNG 自行打包（.NET Icon 可能读不了）');
    }
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const tmpIco = `${cachePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmpIco, ico);
      fs.renameSync(tmpIco, cachePath);
    } catch (e) {
      log.warn('Icon', `写入图标缓存失败：${e && e.message ? e.message : e}`);
      return { path: basePath, badge, cached: false, error: e && e.message ? e.message : String(e) };
    }
    log.info('Icon', `已合成图标（角标：${badge}，尺寸：${ICON_SIZES.join('/')}）`);
    return { path: cachePath, badge, cached: false, error: null };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/** 清理图标缓存（保留现有文件即可，这里只提供手动清空能力） */
export function clearCache() {
  try {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

export { ASSETS_DIR, CACHE_DIR, DEFAULT_ICON };
