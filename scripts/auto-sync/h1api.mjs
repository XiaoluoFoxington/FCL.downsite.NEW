// h1api.mjs — huang1111 (Cloudreve 3.8.5) API 封装
// 只封装「已验证」的端点（见 docs/huang1111-api-notes.md §8 调用链）：
//   GET  /site/captcha            → 验证码图（data:image/png;base64,...）
//   GET  /site/config             → CSRF（响应头 x-csrf-token，每次写请求前重取）
//   POST /user/session            → 登录（验证码 + CSRF）
//   PUT  /directory               → 建目录（幂等，中间目录自动创建）
//   GET  /directory/{路径}        → 列目录（objects：id/name/size/type）
//   POST /aria2/url               → 提交离线下载（响应无 gid，轮询反查）
//   GET  /aria2/finished?page=1   → 任务历史（status: 1=排队 2=下载中 4=完成 5=错误）
//   POST /file/source             → 批量取直链（验证码 + CSRF，验证码一次性）
//
// 重试策略（用户确认）：
//   验证码类失败（登录/取直链）→ 换新验证码最多 10 次
//   离线下载失败              → 提交+轮询最多 3 次
//   其他任何失败（网络/HTTP） → 最多 2 次尝试

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV, RETRY, TIMING } from './config.mjs';

const BASE = ENV.HOST + '/api/v3';
const ORIGIN = ENV.HOST;
const HERE = dirname(fileURLToPath(import.meta.url));
const OCR_HELPER = join(HERE, 'ocr_helper.py');
const PY_BIN = process.platform === 'win32' ? 'python' : 'python3';
const CAPTCHA_PNG = join(tmpdir(), `h1-captcha-${process.pid}.png`);
const OCR_OUT = join(tmpdir(), `h1-ocr-${process.pid}.txt`);

// ---------- 会话状态 ----------
let cookie = ''; // "cloudreve-session=xxx"
let csrf = '';
let isLoggedIn = false;

export class H1Error extends Error {
  constructor(message) {
    super(message);
    this.name = 'H1Error';
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function logMsg(log, msg) {
  if (typeof log === 'function') log(msg);
}

// ---------- 底层请求 ----------
function saveSetCookie(res) {
  const lines = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : res.headers.get('set-cookie')
      ? [res.headers.get('set-cookie')]
      : [];
  for (const line of lines) {
    const m = /^\s*([^=;]+)=([^;]*)/.exec(line);
    if (!m) continue;
    const name = m[1].trim().toLowerCase();
    const val = m[2].trim();
    // 只认 cloudreve-session（其它子域同名 cookie 会干扰会话）
    if (name === 'cloudreve-session') cookie = `cloudreve-session=${val}`;
  }
}

async function api(method, path, body) {
  const headers = { 'Accept': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  if (method !== 'GET') {
    headers['Origin'] = ORIGIN;
    headers['Referer'] = ORIGIN + '/';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  saveSetCookie(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { httpStatus: res.status, json, raw: text.slice(0, 300) };
}

// 写请求前先 GET /site/config 拿最新 CSRF token（实测该响应头必有 x-csrf-token）
async function apiWithToken(method, path, body) {
  const cf = await fetch(BASE + '/site/config', {
    headers: { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    redirect: 'manual',
  });
  saveSetCookie(cf);
  csrf = cf.headers.get('x-csrf-token') || '';
  if (!csrf) throw new H1Error('GET /site/config 未返回 x-csrf-token');
  return api(method, path, body);
}

// 其他任何失败：最多重试（再尝试）N-1 次，默认 RETRY.GENERIC_ATTEMPTS 次尝试
async function genericAttempts(fn, label, log, attempts = RETRY.GENERIC_ATTEMPTS) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts) logMsg(log, `  [${label}] 第${i}次失败（${e.message}），重试…`);
    }
  }
  throw lastErr;
}

// ---------- 验证码 OCR ----------
async function recognizeCaptcha(log) {
  const r = await fetch(BASE + '/site/captcha?_=' + Date.now(), {
    headers: { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    redirect: 'manual',
  });
  saveSetCookie(r);
  const j = await r.json();
  if (j.code !== 0) throw new H1Error('captcha 获取失败: ' + (j.msg || r.raw));
  const b64 = j.data.split(',')[1];
  writeFileSync(CAPTCHA_PNG, Buffer.from(b64, 'base64'));
  let code = '';
  try {
    // 结果写入临时文件读取，避免子进程 stdout 管道捕获受限
    if (existsSync(OCR_OUT)) unlinkSync(OCR_OUT);
    execFileSync(PY_BIN, [OCR_HELPER, CAPTCHA_PNG, OCR_OUT], { stdio: 'ignore' });
    code = existsSync(OCR_OUT) ? readFileSync(OCR_OUT, 'utf8').trim() : '';
  } catch (e) {
    logMsg(log, `  [OCR] 子进程失败：${e.message}`);
  } finally {
    if (existsSync(CAPTCHA_PNG)) unlinkSync(CAPTCHA_PNG);
    if (existsSync(OCR_OUT)) unlinkSync(OCR_OUT);
  }
  return code; // 可能为空/长度≠4，由调用方判定
}

// ---------- 登录（验证码重试 ≤10，换新验证码） ----------
export async function login(user, password, log) {
  isLoggedIn = false;
  for (let attempt = 1; attempt <= RETRY.CAPTCHA_ATTEMPTS; attempt += 1) {
    logMsg(log, `[登录] 第 ${attempt}/${RETRY.CAPTCHA_ATTEMPTS} 次：取验证码+OCR`);
    let code = '';
    try {
      code = await recognizeCaptcha(log);
    } catch (e) {
      logMsg(log, `  [登录] 验证码获取失败：${e.message}，换新验证码`);
      continue;
    }
    if (code.length !== 4) {
      logMsg(log, `  [登录] OCR 长度≠4（${code || '空'}），换新验证码`);
      continue;
    }
    let r;
    try {
      r = await genericAttempts(
        () => apiWithToken('POST', '/user/session', { userName: user, Password: password, captchaCode: code }),
        '登录 POST',
        log,
      );
    } catch (e) {
      logMsg(log, `  [登录] 请求异常：${e.message}，换新验证码重试`);
      continue;
    }
    if (r.json?.code === 0) {
      isLoggedIn = true;
      logMsg(log, `  [登录] 成功（第 ${attempt} 次）`);
      return;
    }
    if (r.json?.code === 40026) {
      logMsg(log, `  [登录] 验证码错误(40026)（${code}），换新验证码`);
      continue;
    }
    logMsg(log, `  [登录] 非验证码错误：HTTP ${r.httpStatus} ${r.json?.msg || r.raw}，换新验证码`);
  }
  throw new H1Error(`登录失败：验证码尝试 ${RETRY.CAPTCHA_ATTEMPTS} 次均未成功`);
}

// ---------- 目录 ----------
// netPath：不带前导斜杠的完整路径，如 `foldcraftlauncher_cn_auto/0/1/3/2/8`
export async function listDir(netPath, log) {
  const pathForApi = netPath.split('/').map(encodeURIComponent).join('/');
  const r = await genericAttempts(() => api('GET', '/directory/' + pathForApi), `列目录 ${netPath}`, log);
  if (r.json?.code === 40016) return { exists: false, objects: [] }; // 目录不存在
  if (r.json?.code !== 0) throw new H1Error(`列目录失败(HTTP ${r.httpStatus}): ${r.json?.msg || r.raw}`);
  return { exists: true, objects: r.json.data?.objects || [], parent: r.json.data?.parent };
}

// 幂等创建目录（PUT /directory 会连同中间目录一起创建）
export async function createDir(netPath, log) {
  const found = await listDir(netPath, log);
  if (found.exists) return found;
  logMsg(log, `  [目录] 创建 /${netPath}`);
  const r = await genericAttempts(
    () => apiWithToken('PUT', '/directory', { path: '/' + netPath }),
    `建目录 ${netPath}`,
    log,
  );
  if (r.json?.code !== 0 && r.json?.code !== 40016) {
    // 40016 兜底：偶发竞态（刚创建完又查），视为已存在
    throw new H1Error(`建目录失败(HTTP ${r.httpStatus}): ${r.json?.msg || r.raw}`);
  }
  return listDir(netPath, log);
}

// ---------- 离线下载 ----------
// urls: GitHub release asset 直链数组；wantNames: 期望出现的文件名数组
// 返回 Map<文件名, {id,size}>；失败（提交或轮询超时/任务错误）抛 H1Error
// 记录提交前已存在的同 dst+文件名任务 gid，避免历史失败任务在重试时被误判为“本次失败”
async function collectFinishedGids(dst, wantNames) {
  const dstNorm = dst.replace(/^\/+|\/+$/g, '') || '/';
  const gids = new Set();
  try {
    const f = await api('GET', '/aria2/finished?page=1');
    for (const t of f.json?.data || []) {
      const tDst = (t.dst || '').replace(/^\/+|\/+$/g, '') || '/';
      if (tDst === dstNorm && wantNames.includes(t.name) && t.gid) gids.add(String(t.gid));
    }
  } catch {
    // 基线只用于排除“上一次失败”的历史任务；拿不到时仍以目录出现文件为准
  }
  return gids;
}

// 收集正在下载中的任务（GET /aria2/downloading），返回匹配 dst 的文件名集合
// 用于重试时跳过已在下载中的文件，避免重复 aria2 任务
async function collectDownloadingNames(dst, wantNames) {
  const dstNorm = dst.replace(/^\/+|\/+$/g, '') || '/';
  const names = new Set();
  try {
    const r = await api('GET', '/aria2/downloading');
    for (const t of r.json?.data || []) {
      const tDst = (t.dst || '').replace(/^\/+|\/+$/g, '') || '/';
      if (tDst === dstNorm) {
        const taskName = t.name || t.files?.[0]?.path || '';
        if (wantNames.includes(taskName)) names.add(taskName);
      }
    }
  } catch {
    // 拿不到就视为无下载中任务，按原逻辑提交
  }
  return names;
}

export async function offlineDownload(urls, netPath, wantNames, log) {
  const dst = '/' + netPath; // 实测 finished 任务 dst 带前导斜杠
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY.DOWNLOAD_ATTEMPTS; attempt += 1) {
    logMsg(log, `  [离线下载] 第 ${attempt}/${RETRY.DOWNLOAD_ATTEMPTS} 次：准备处理 ${urls.length} 个文件`);
    try {
      await createDir(netPath, log);

      // 检查正在下载的任务，避免重试时重复提交同一文件
      const downloadingNames = await collectDownloadingNames(dst, wantNames);
      if (downloadingNames.size > 0) {
        logMsg(log, `  [离线下载] 发现 ${downloadingNames.size}/${wantNames.length} 个文件已在下载中，跳过重复提交`);
      }

      // 分离：已在下载的文件 → 跳过提交；其余 → 本次提交
      const pendingUrls = [];
      const pendingNames = [];
      for (let i = 0; i < wantNames.length; i += 1) {
        if (!downloadingNames.has(wantNames[i])) {
          pendingUrls.push(urls[i]);
          pendingNames.push(wantNames[i]);
        }
      }

      const baselineGids = await collectFinishedGids(dst, wantNames);

      if (pendingUrls.length > 0) {
        logMsg(log, `  [离线下载] 提交 ${pendingUrls.length} 个新 URL`);
        const r = await genericAttempts(
          () => apiWithToken('POST', '/aria2/url', { url: pendingUrls, dst, preferred_node: 0 }),
          '提交 aria2',
          log,
        );
        const data = r.json?.data || [];
        const bad = data.find((x) => x?.code !== 0);
        if (bad) throw new H1Error('任务提交失败: ' + (bad.msg || ''));
      } else {
        logMsg(log, `  [离线下载] 全部 ${wantNames.length} 个文件已在下载中，跳过提交，直接轮询`);
      }

      // 轮询全部文件（含之前已在下载的 + 本次新提交的）
      const files = await pollForFiles(netPath, dst, wantNames, log, baselineGids);
      return files;
    } catch (e) {
      lastErr = e;
      logMsg(log, `  [离线下载] 第 ${attempt} 次失败：${e.message}`);
      if (attempt < RETRY.DOWNLOAD_ATTEMPTS) await sleep(3000); // 下次提交前稍等
    }
  }
  throw new H1Error(`离线下载失败：${RETRY.DOWNLOAD_ATTEMPTS} 次均未成功（${lastErr?.message || ''}）`);
}

// 轮询：finished 任务错误(5) 或 目录出现全部期望文件
// 返回 Map<文件名, {id,size}>
async function pollForFiles(netPath, dst, wantNames, log, baselineGids = new Set()) {
  const dstNorm = dst.replace(/^\/+|\/+$/g, '') || '/';
  const deadline = Date.now() + ENV.DOWNLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // 1) finished 任务错误检测（status=5），但排除提交前已存在的历史任务
    try {
      const f = await api('GET', '/aria2/finished?page=1');
      for (const t of f.json?.data || []) {
        const tDst = (t.dst || '').replace(/^\/+|\/+$/g, '') || '/';
        if (baselineGids.has(String(t.gid || ''))) continue;
        if (tDst === dstNorm && wantNames.includes(t.name) && t.status === 5) {
          throw new H1Error(`aria2 任务错误(status=5): ${t.error || t.name}`);
        }
      }
    } catch (e) {
      if (e instanceof H1Error) throw e; // 任务明确失败 → 立即报错，交给上层重试
      // 其它（网络抖动）→ 继续轮询
    }
    // 2) 目录出现全部期望文件 → 成功
    let dir;
    try {
      dir = await listDir(netPath, log);
    } catch {
      dir = { exists: false, objects: [] }; // 轮询中的瞬时失败，继续等
    }
    if (dir.exists) {
      const files = new Map();
      for (const o of dir.objects) {
        if (o.type === 'file' && wantNames.includes(o.name)) files.set(o.name, { id: o.id, size: o.size });
      }
      if (wantNames.every((n) => files.has(n))) return files;
    }
    await sleep(TIMING.POLL_INTERVAL_MS);
  }
  throw new H1Error(`轮询超时(${Math.round(ENV.DOWNLOAD_TIMEOUT_MS / 1000)}s)：${netPath} 未出现全部期望文件`);
}

// ---------- 批量取直链（验证码重试 ≤10，换新验证码） ----------
// fileIds: 文件 id 数组；返回 [{id,url,name}]
export async function getSources(fileIds, log) {
  for (let attempt = 1; attempt <= RETRY.CAPTCHA_ATTEMPTS; attempt += 1) {
    logMsg(log, `  [取直链] 第 ${attempt}/${RETRY.CAPTCHA_ATTEMPTS} 次：取验证码+OCR（${fileIds.length} 个文件）`);
    let code = '';
    try {
      code = await recognizeCaptcha(log);
    } catch (e) {
      logMsg(log, `  [取直链] 验证码获取失败：${e.message}，换新验证码`);
      continue;
    }
    if (code.length !== 4) {
      logMsg(log, `  [取直链] OCR 长度≠4（${code || '空'}），换新验证码`);
      continue;
    }
    let r;
    try {
      r = await genericAttempts(
        () => apiWithToken('POST', '/file/source', { items: fileIds, captchaCode: code }),
        '取直链 POST',
        log,
      );
    } catch (e) {
      logMsg(log, `  [取直链] 请求异常：${e.message}，换新验证码`);
      continue;
    }
    if (r.json?.code === 0 && Array.isArray(r.json.data) && r.json.data.length === fileIds.length) {
      logMsg(log, `  [取直链] 成功（第 ${attempt} 次）`);
      return r.json.data;
    }
    if (r.json?.code === 40026) {
      logMsg(log, `  [取直链] 验证码错误(40026)（${code}），换新验证码`);
      continue;
    }
    logMsg(log, `  [取直链] 异常返回：HTTP ${r.httpStatus} ${r.json?.msg || r.raw}，换新验证码重试`);
  }
  throw new H1Error(`取直链失败：验证码尝试 ${RETRY.CAPTCHA_ATTEMPTS} 次均未成功`);
}

export function isAuthed() {
  return isLoggedIn;
}