// wifi.mjs — 网络检查与 WiFi 连接/断开/忘记（可选功能，默认关闭）
//
// 设计 §9 的硬约束：
//   · 只有「本程序为本轮同步新建立的目标连接」才允许在 Finish 阶段断开；
//     用户本来就连着目标 WiFi 时，绝不擅自断开。
//   · 忘记配置必须精确限定目标 SSID，不能清理其它已保存的 WiFi。
//   · WiFi 失败不得让程序崩溃：所有 netsh 调用都带超时 + 捕获。
//
// 实现说明：
//   · 只用系统自带的 netsh（无依赖、无管理员权限）；输出在中文 Windows 上是 GBK，
//     用 TextDecoder('gbk') 解码（Node 默认带 full-icu，支持 gbk）。
//   · 是否可用看「DNS + HTTPS 可达性」，不看 WiFi 图标是否显示已连接。

import dns from 'node:dns/promises';
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const decoderUtf8 = new TextDecoder('utf-8');
let gbkDecoder = null;
function decode(buf) {
  if (!buf || !buf.length) return '';
  try {
    if (!gbkDecoder) gbkDecoder = new TextDecoder('gbk');
    return gbkDecoder.decode(buf);
  } catch {
    return decoderUtf8.decode(buf);
  }
}

// ---------- 进程调用 ----------

function runNetsh(args, { timeoutMs = 30000 } = {}) {
  try {
    const r = spawnSync('netsh', args, { windowsHide: true, timeout: timeoutMs, encoding: 'buffer' });
    return {
      ok: r.status === 0,
      code: r.status,
      text: `${decode(r.stdout || Buffer.alloc(0))}${decode(r.stderr || Buffer.alloc(0))}`,
      error: r.error ? (r.error.message || String(r.error)) : null,
    };
  } catch (e) {
    return { ok: false, code: null, text: '', error: e && e.message ? e.message : String(e) };
  }
}

// ---------- 网络可达性 ----------

function httpsProbe(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      resolve({ ok, detail });
    };
    const req = https.request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
      res.resume();
      done(true, `HTTPS ${res.statusCode}`);
    });
    req.on('timeout', () => { req.destroy(); done(false, 'HTTPS 超时'); });
    req.on('error', (e) => done(false, `HTTPS 失败：${e.code || e.message}`));
    req.end();
  });
}

/**
 * 网络状态：DNS 解析 + HTTPS 可达性。
 * @returns {Promise<{online:boolean, dns:boolean, https:boolean, detail:string}>}
 */
export async function checkNetwork({ timeoutMs = 8000, host = 'api.github.com' } = {}) {
  let dnsOk = false;
  let dnsDetail = '';
  try {
    const res = await dns.lookup(host);
    dnsOk = Boolean(res && res.address);
    dnsDetail = dnsOk ? `${host} → ${res.address}` : `${host} 解析为空`;
  } catch (e) {
    dnsDetail = `DNS 失败：${e.code || e.message}`;
  }

  const probe = await httpsProbe('https://api.github.com/', timeoutMs);
  return {
    online: dnsOk && probe.ok,
    dns: dnsOk,
    https: probe.ok,
    detail: `${dnsDetail}｜${probe.detail}`,
  };
}

// ---------- WiFi 状态 ----------

/** 解析 `netsh wlan show interfaces` 的输出（导出以便单测） */
export function parseInterfaces(text) {
  const result = { connected: false, ssid: '', state: '' };
  if (!text) return result;
  const ssidMatch = /^\s*SSID\s*:\s*(.+?)\s*$/mi.exec(text);
  if (ssidMatch) result.ssid = ssidMatch[1].trim();
  const isDisconnected = (value) => /已断开|已中斷|未连接|未連線|disconnected|not\s+connected/i.test(String(value || ''));
  // 注意：不能直接 /connected/ 子串匹配 —— "disconnected" 里也含 "connected"（英文 Windows 实测踩过）
  const isConnected = (value) => {
    const bare = String(value || '').replace(/disconnected/gi, '');
    return /已连接|已連線|connected/i.test(bare);
  };

  const stateMatch = /^\s*(?:状态|State)\s*:\s*(.+?)\s*$/mi.exec(text);
  if (stateMatch) {
    result.state = stateMatch[1].trim();
    result.connected = !isDisconnected(result.state) && isConnected(result.state);
  } else if (result.ssid) {
    // 某些语言版本没有「状态」行，但有 SSID 且不是「已断开」就按已连接处理
    result.connected = !isDisconnected(text);
  }
  return result;
}

/** 当前 WiFi 接口状态 */
export function wifiState() {
  if (os.platform() !== 'win32') return { connected: false, ssid: '', state: '', error: '非 Windows 平台' };
  const r = runNetsh(['wlan', 'show', 'interfaces'], { timeoutMs: 20000 });
  if (!r.ok && !r.text) return { connected: false, ssid: '', state: '', error: r.error || `netsh 退出码 ${r.code}` };
  return { ...parseInterfaces(r.text), error: r.ok ? null : (r.error || 'netsh 返回非零') };
}

/** 是否已有目标 SSID 的保存配置（精确匹配 SSID 名） */
export function hasProfile(ssid) {
  if (!ssid) return false;
  const r = runNetsh(['wlan', 'show', 'profiles'], { timeoutMs: 20000 });
  if (!r.ok) return false;
  return r.text.split(/\r?\n/).some((line) => line.trim().endsWith(`: ${ssid}`) || line.trim().endsWith(`:${ssid}`) || line.trim() === ssid);
}

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** 生成 WPA2-PSK 的 WLAN 配置 XML */
export function buildProfileXml(ssid, password) {
  return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${xmlEscape(ssid)}</name>
  <SSIDConfig>
    <SSID>
      <name>${xmlEscape(ssid)}</name>
    </SSID>
  </SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>auto</connectionMode>
  <MSM>
    <security>
      <authEncryption>
        <authentication>WPA2PSK</authentication>
        <encryption>AES</encryption>
        <useOneX>false</useOneX>
      </authEncryption>
      <sharedKey>
        <keyType>passPhrase</keyType>
        <protected>false</protected>
        <keyMaterial>${xmlEscape(password)}</keyMaterial>
      </sharedKey>
    </security>
  </MSM>
</WLANProfile>
`;
}

/** 写入临时 XML（UTF-8 带 BOM，netsh 对两种都能读，带 BOM 兼容性更好） */
function writeTempProfile(ssid, password) {
  const file = path.join(os.tmpdir(), `fdn-wlan-${process.pid}-${Date.now()}.xml`);
  const body = buildProfileXml(ssid, password);
  fs.writeFileSync(file, `\ufeff${body}`, 'utf8');
  return file;
}

/**
 * 连接到指定 SSID。
 * @returns {{ok:boolean, method:string, pending?:boolean, error:string|null}}
 */
export function connect(ssid, password = '') {
  if (!ssid) return { ok: false, method: 'none', error: '未配置 WiFi 名称' };

  if (hasProfile(ssid)) {
    const r = runNetsh(['wlan', 'connect', `name=${ssid}`, `ssid=${ssid}`], { timeoutMs: 30000 });
    if (r.ok) return { ok: true, method: 'saved-profile', error: null };
    // 已保存的配置可能密码变了，继续用配置里的密码重写
  }

  if (!password) return { ok: false, method: 'saved-profile', error: '系统没有该 WiFi 的保存配置，且配置里没有密码' };

  const file = writeTempProfile(ssid, password);
  try {
    const add = runNetsh(['wlan', 'add', 'profile', `filename=${file}`, 'user=current'], { timeoutMs: 30000 });
    if (!add.ok) return { ok: false, method: 'add-profile', error: `写入 WiFi 配置失败：${add.text.trim().split(/\r?\n/).slice(-2).join(' / ') || add.error}` };
    const r = runNetsh(['wlan', 'connect', `name=${ssid}`, `ssid=${ssid}`], { timeoutMs: 30000 });
    if (r.ok) return { ok: true, method: 'profile-with-password', error: null };
    return { ok: false, method: 'connect', error: `连接失败：${r.text.trim().split(/\r?\n/).slice(-2).join(' / ') || r.error}` };
  } finally {
    try { fs.unlinkSync(file); } catch { /* 忽略 */ }
  }
}

/** 断开当前 WiFi 接口 */
export function disconnect() {
  const r = runNetsh(['wlan', 'disconnect'], { timeoutMs: 30000 });
  return { ok: r.ok, error: r.ok ? null : (r.text.trim() || r.error) };
}

/** 忘记指定 SSID 的配置（精确匹配；不批量清理） */
export function forget(ssid) {
  if (!ssid) return { ok: false, error: '未配置 WiFi 名称' };
  const r = runNetsh(['wlan', 'delete', 'profile', `name=${ssid}`], { timeoutMs: 30000 });
  return { ok: r.ok, error: r.ok ? null : (r.text.trim() || r.error) };
}

/** 轮询等待目标 SSID 连上（最多 waitMs） */
export async function waitForConnected(ssid, { waitMs = 30000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + waitMs;
  do {
    const st = wifiState();
    if (st.connected && (!ssid || st.ssid === ssid)) return { ok: true, state: st };
    await new Promise((r) => setTimeout(r, intervalMs));
  } while (Date.now() < deadline);
  return { ok: false, state: wifiState() };
}

// ---------- 阶段封装 ----------

/**
 * Prepare 阶段：检查网络，必要时连接目标 WiFi。
 * @returns {Promise<{ok:boolean, skipRound:boolean, connectedByUs:boolean, wasConnected:boolean, warnings:string[]|null, error:object|null, session:object}>}
 */
export async function prepare(config, log = { line: () => {}, warn: () => {}, info: () => {} }) {
  const wifi = (config && config.wifi) || {};
  const session = { enabled: Boolean(wifi.enabled), ssid: wifi.ssid || '', connectedByUs: false, wasConnected: false };
  const warnings = [];

  if (!wifi.enabled) {
    const net = await checkNetwork();
    session.network = net;
    if (!net.online) {
      warnings.push(`网络不可达：${net.detail}`);
      log.warn('Prepare', `网络检查未通过（WiFi 管理未启用）：${net.detail}，继续尝试同步`);
    } else {
      log.info('Prepare', `网络检查通过：${net.detail}`);
    }
    return { ok: true, skipRound: false, connectedByUs: false, wasConnected: false, warnings, error: null, session };
  }

  const before = wifiState();
  if (before.error) {
    warnings.push(`无法读取 WiFi 状态：${before.error}`);
    log.warn('Prepare', `无法读取 WiFi 状态：${before.error}`);
  }
  session.wasConnected = Boolean(before.connected && before.ssid === session.ssid);
  session.before = before;

  let net = await checkNetwork();
  session.network = net;
  log.info('Prepare', `网络检查：${net.online ? '通过' : '不通'}｜${net.detail}`);

  const needConnect = !net.online || wifi.alwaysConnect;
  if (!needConnect) {
    log.info('Prepare', `网络正常且未要求总是连接，保持当前网络（当前 WiFi：${before.ssid || '未知'}）`);
    return { ok: true, skipRound: false, connectedByUs: false, wasConnected: session.wasConnected, warnings, error: null, session };
  }

  log.info('Prepare', `准备连接 WiFi「${session.ssid}」（${net.online ? 'alwaysConnect=true' : '当前网络不通'}）`);
  const useSavedFirst = wifi.useSavedFirst !== false;
  let result;
  if (useSavedFirst && hasProfile(session.ssid)) {
    result = connect(session.ssid, '');
    if (!result.ok && wifi.password) {
      log.warn('Prepare', `使用已保存配置连接失败：${result.error}，改用配置文件里的密码重试`);
      result = connect(session.ssid, wifi.password);
    }
  } else if (wifi.password) {
    result = connect(session.ssid, wifi.password);
  } else {
    result = connect(session.ssid, '');
  }

  if (!result.ok) {
    const message = `WiFi 连接失败：${result.error || '未知错误'}`;
    warnings.push(message);
    log.warn('Prepare', message);
    if (wifi.skipOnFailure !== false) {
      return { ok: false, skipRound: true, connectedByUs: false, wasConnected: session.wasConnected, warnings, error: { code: 'WIFI_CONNECT_FAILED', message }, session };
    }
    return { ok: true, skipRound: false, connectedByUs: false, wasConnected: session.wasConnected, warnings, error: null, session };
  }

  const waited = await waitForConnected(session.ssid);
  if (!waited.ok) {
    const message = `WiFi「${session.ssid}」连接后未能上网（当前：${waited.state.ssid || '无'}）`;
    warnings.push(message);
    log.warn('Prepare', message);
    if (wifi.skipOnFailure !== false) {
      return { ok: false, skipRound: true, connectedByUs: false, wasConnected: session.wasConnected, warnings, error: { code: 'WIFI_UNUSABLE', message }, session };
    }
  }

  // 本次是本程序建立的目标连接（且此前用户并没有连着它）才算 connectedByUs
  session.connectedByUs = !session.wasConnected;
  session.after = wifiState();
  log.info('Prepare', `已连接 WiFi「${session.ssid}」（方式：${result.method}）${session.connectedByUs ? '，本轮结束时按配置决定是否断开' : ''}`);
  return { ok: true, skipRound: false, connectedByUs: session.connectedByUs, wasConnected: session.wasConnected, warnings, error: null, session };
}

/**
 * Finish 阶段：按配置断开/忘记。
 * @param {object} config
 * @param {{connectedByUs:boolean, session:object}} prepared prepare() 的返回值
 * @param {{failed:boolean}} outcome 本轮是否失败
 */
export function finish(config, prepared, outcome = { failed: false }, log = { info: () => {}, warn: () => {} }) {
  const warnings = [];
  const wifi = (config && config.wifi) || {};
  if (!wifi.enabled || !wifi.disconnectAfter) return { warnings, disconnected: false, forgotten: false };

  const connectedByUs = Boolean(prepared && prepared.connectedByUs);
  if (!connectedByUs) {
    log.info('Finish', '本轮不是本程序建立的 WiFi 连接，不断开（避免误断用户自己的连接）');
    return { warnings, disconnected: false, forgotten: false };
  }
  if (outcome.failed && wifi.disconnectEvenOnFailure === false) {
    log.info('Finish', '本轮失败且配置为「失败时不断开」，保留连接');
    return { warnings, disconnected: false, forgotten: false };
  }

  const r = disconnect();
  if (!r.ok) {
    const msg = `断开 WiFi 失败：${r.error}`;
    warnings.push(msg);
    log.warn('Finish', msg);
    return { warnings, disconnected: false, forgotten: false };
  }
  log.info('Finish', `已断开 WiFi「${(prepared.session || {}).ssid || ''}」`);

  let forgotten = false;
  if (wifi.forgetOnDisconnect) {
    const f = forget((prepared.session || {}).ssid || '');
    if (f.ok) {
      forgotten = true;
      log.info('Finish', `已忘记 WiFi 配置「${(prepared.session || {}).ssid || ''}」`);
    } else {
      const msg = `忘记 WiFi 配置失败：${f.error}`;
      warnings.push(msg);
      log.warn('Finish', msg);
    }
  }
  return { warnings, disconnected: true, forgotten };
}

export { runNetsh };
