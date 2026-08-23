/**
 * 下载页的设备架构推断规则。
 * 它只影响绿色推荐行，不会隐藏其他下载项；无法识别时用户仍可手动选择 all 架构。
 */

import { t } from '../common/i18n.js';

// windows 系统不要根据平台来判断架构!!!
// windows 系统不管是 64 位还是 32 位始终为 win32 平台
// 再乱改我就炸了!!!
//                                            晚梦

// 顺序很重要：arm64/x86_64 必须先于更宽泛的 arm/x86 匹配。

const ARCHITECTURES = [
  { pattern: /aarch64|arm64|armv8/i, name: 'arm64-v8a' },
  { pattern: /armeabi-v7a|armv7|\barm\b/i, name: 'armeabi-v7a' },
  { pattern: /x86_64|x64|amd64/i, name: 'x86_64' },
  { pattern: /\bx86\b|i[36]86/i, name: 'x86' },
  // "all" 必须作为独立分段（-all-、_all.、/all/、行首行尾等）才算全架构，
  // 裸 /all/i 会把 installer、fallback 等含 "all" 子串的文件误判为 all。
  // 下划线是 \w 字符，\ball\b 无法识别 _all 分段，因此用显式分隔符集合。
  { pattern: /(^|[\s._\-/])all([\s._\-/]|$)/i, name: 'all' },
];

/**
 * 从 UAParser 读取系统、浏览器和 CPU 信息。
 * @returns {{fullResult: object, matchedArchitecture: string|null}}
 */
export function detectSystemInfo() {
  // UAParser 是下载页专属的可选 CDN 依赖。加载失败时仍允许用户手动选择架构。
  if (typeof window.UAParser !== 'function') {
    return { fullResult: {}, matchedArchitecture: null };
  }
  const result = new window.UAParser().getResult();
  const cpuArchitecture = result.cpu.architecture || navigator.platform || '';
  return {
    fullResult: result,
    matchedArchitecture: ARCHITECTURES.find(({ pattern }) => pattern.test(cpuArchitecture))?.name || null,
  };
}

/**
 * 对统一下载项补充架构：显式字段优先，随后从文件名/地址推断。
 * @param {{architecture?: string, downloadUrl?: string, name?: string}} item 统一下载叶子节点
 */
export function inferArchitecture(item) {
  // 线路显式提供的 architecture 优先级最高；文件名推断仅作为兼容旧镜像的后备。
  if (item.architecture) return item.architecture;
  const source = `${item.downloadUrl || ''} ${item.name || ''}`;
  const matched = ARCHITECTURES.find(({ pattern }) => pattern.test(source));
  if (matched) return matched.name;
  if (source.includes('ZalithLauncher')) return 'all';
  return '';
}

/**
 * 比较两个版本号。返回负数表示 a < b，0 表示相等，正数表示 a > b。
 * @param {string} a 版本号 A，如 "7"、"8.0"
 * @param {string} b 版本号 B
 * @returns {number}
 */
function compareVersion(a, b) {
  const aParts = String(a).split('.').map(Number);
  const bParts = String(b).split('.').map(Number);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const av = aParts[i] || 0;
    const bv = bParts[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * 根据 OSRequest 检查当前系统是否满足要求，返回警告消息数组。
 * @param {Array<{osName: string, osVersion: string}>} osRequests OS 需求列表
 * @param {{fullResult: object}} system detectSystemInfo 的返回值
 * @returns {Array<{type: string, text: string}>} 警告消息数组
 */
export function checkOSRequirement(osRequests, system) {
  const messages = [];
  if (!Array.isArray(osRequests) || osRequests.length === 0) return messages;

  const osName = system?.fullResult?.os?.name;
  const osVersion = system?.fullResult?.os?.version;

  if (!osName) {
    messages.push({ type: 'warning', text: t('common.system.cannotDetectOs') });
    return messages;
  }

  const matched = osRequests.find(
    (req) => req.osName?.toLowerCase() === osName.toLowerCase()
  );

  if (!matched) {
    const supportedNames = osRequests.map((r) => r.osName).join(t('common.separator'));
    messages.push({
      type: 'warning',
      text: t('common.system.osRequirement', { supported: supportedNames, osName }),
    });
    return messages;
  }

  if (matched.osVersion && osVersion) {
    if (compareVersion(osVersion, matched.osVersion) < 0) {
      messages.push({
        type: 'warning',
        text: t('common.system.osVersionRequirement', {
          osName: matched.osName,
          osVersion: matched.osVersion,
          currentOs: osName,
          currentVersion: osVersion,
        }),
      });
    }
  }

  return messages;
}

/**
 * 将 UAParser 结果转为消息数组，用于下载页展示系统与浏览器信息。
 * @param {{fullResult: object, matchedArchitecture: string|null}} system detectSystemInfo 的返回值
 * @returns {Array<{type: string, text: string}>} 消息数组
 */
export function buildSystemMessages(system) {
  const messages = [];
  const result = system?.fullResult;
  if (!result || typeof result !== 'object') return messages;

  const parts = [];

  if (result.os?.name) {
    const osText = result.os.version
      ? `${result.os.name} ${result.os.version}`
      : result.os.name;
    parts.push(osText);
  }

  if (result.browser?.name) {
    const browserText = result.browser.version
      ? `${result.browser.name} ${result.browser.version}`
      : result.browser.name;
    parts.push(browserText);
  }

  if (result.device?.type && result.device.type !== 'desktop') {
    const deviceParts = [];
    if (result.device.vendor) deviceParts.push(result.device.vendor);
    if (result.device.model) deviceParts.push(result.device.model);
    if (result.device.type) deviceParts.push(result.device.type);
    parts.push(deviceParts.join(' '));
  }

  if (result.cpu?.architecture) {
    parts.push(t('common.system.cpuInfo', { arch: result.cpu.architecture }));
  }

  if (parts.length > 0) {
    messages.push({ type: 'info', text: parts.join(' · ') });
  }

  if (system?.matchedArchitecture) {
    messages.push({ type: 'success', text: t('common.system.matchedArch', { arch: system.matchedArchitecture }) });
  }

  return messages;
}

/**
 * 系统 → 下载文件扩展名白名单。
 * 键为 UAParser os.name 的原始值（小写比较）；值为该平台常见的安装包/可执行文件扩展名（不含点）。
 * 各系统追加通用压缩包扩展名，避免误杀便携版/源码包。
 * HarmonyOS 为纯血鸿蒙（HarmonyOS NEXT），不兼容 Android，仅认 .hap（应用安装包）与 .app（应用市场分发格式）。
 */
const SYSTEM_EXTENSIONS = {
  android: ['apk', 'apks', 'xapk', 'apkm'],
  windows: ['exe', 'msi', 'msix', 'appx', 'appxbundle', 'msixbundle'],
  'mac os': ['dmg', 'pkg'],
  linux: ['AppImage', 'deb', 'rpm', 'flatpak', 'snap'],
  harmonyos: ['hap', 'app'],
};

/** 各平台通用的压缩包扩展名，追加到任何已知系统的白名单中。 */
const COMMON_ARCHIVE_EXTENSIONS = ['zip', '7z', 'tar.gz', 'tar.xz', 'tgz', 'txz'];

/**
 * 根据系统名称返回下载文件扩展名白名单（不含点，小写比较用）。
 * 未识别系统返回空数组（不启用系统自动筛选），避免未知平台只显示压缩包。
 * @param {string|undefined} osName UAParser 返回的系统名，如 "Android"、"Windows"、"Mac OS"、"Linux"
 * @returns {Array<string>} 扩展名列表（小写），空数组表示不筛选
 */
export function getSystemDownloadExtensions(osName) {
  const normalized = String(osName || '').toLowerCase();
  const base = SYSTEM_EXTENSIONS[normalized];
  // 未识别系统不启用筛选；已知系统则叠加通用压缩包白名单。
  if (!base) return [];
  return [...new Set([...base, ...COMMON_ARCHIVE_EXTENSIONS].map((ext) => ext.toLowerCase()))];
}
