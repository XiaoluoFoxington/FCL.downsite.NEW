// h1api.mjs — huang1111 (Cloudreve 3.8.7) API 封装
// 只封装「已验证」的端点（见 docs/huang1111-api-notes.md §8 调用链）：
//   GET  /site/config             → CSRF（响应头 x-csrf-token，每次写请求前重取）+ 站点配置
//   POST /user/session            → 登录
//   PUT  /directory               → 建目录（幂等，中间目录自动创建）
//   GET  /directory/{路径}        → 列目录（objects：id/name/size/type）
//   POST /aria2/url               → 提交离线下载（响应无 gid，轮询反查）
//   GET  /aria2/downloading       → 正在下载的任务（仅用于跳过重复提交）
//   POST /file/source             → 批量取直链
//   POST /site/captcha/policy     → 提交 PoW，换取「验证通过」许可
//
// ============================ 验证协议（2026-10-02 逆向 + 实测） ============================
//
// 站点已升级为 **captcha policy v2**，旧的两条验证通路（图形验证码 captchaCode / 裸 PoW powPayload）
// **全部作废**。旧脚本死在一个前置条件上：**每个请求都必须声明协议版本**。
//
//   ⚠ 不带 `X-Cloudreve-Captcha-Protocol: 2` → 一律 HTTP 200 + code=41709
//       "Please update this page to use the new verification. / 请更新页面后使用新版验证。"
//       （旧脚本正是这么失败的；带 Protocol: 1 同样 41709）
//
// 新流程是「挑战 → 许可」两段式（对应前端 webpack module 197 的 `ensure()` + axios 拦截器）：
//
//   ① 正常发请求（带 X-Cloudreve-Captcha-Protocol: 2）
//   ② 若该请求需要验证 → code=41700，且 **响应 data 里直接内嵌 policy 对象**：
//        { id, purpose, required:{interactive,pow,level,reason}, revision, expires,
//          pow:{...PoW 挑战...}, interactive_done, pow_done, ready }
//      · required.interactive === 0 时 interactive_done 直接为 true（**无需滑块**）
//      · pow.token 是**绑定该 policy.id 的 JWT**（带 binding claim），与单独 GET /site/captcha/pow 拿到的
//        那种**不通用** —— 必须用 41700 内嵌的这一份
//   ③ 解 PoW（算法未变，见下）→ POST /site/captcha/policy { id, pow_payload }
//      · 字段名是 **pow_payload**（下划线），值是 JSON.stringify({token,counter}) 的**字符串**
//      · 成功 → code=0，data.ready=true，**id 保持不变**
//   ④ 重发原请求，附加请求头 `X-Cloudreve-Captcha-Permit: <policy.id>` → 这才拿到真实业务结果
//
//   ⚠⚠ 必须携带**全部 cookie**：`cloudreve-session` + `cloudreve_observer` + `cloudreve_send`。
//      旧文档「cloudreve_observer 非必需」已失效。实测只带 cloudreve-session 时
//      POST /site/captcha/policy 恒返回 41701（验证失败）；带全量 cookie 才 code=0。
//      cloudreve_observer / cloudreve_send 由 41700 响应下发。
//
// PoW 协议（cloudreve-pow-v1，**算法与上一版完全一致**，未变）：
//   password = "Cloudreve-PoW/v1" || 0x00 || nonce
//   salt     = salt || uint32_be(counter)
//   PBKDF2-SHA256(password, salt, iterations, 256bit) == target  → 该 counter 即答案
//   站点下发的 iterations=3000、counterLimit=5000；求解为单线程逐 counter 试算，
//   耗时随答案位置浮动（数十秒级），故 solvePow 内做进度日志与硬超时。
//
// 错误码（实测）：
//   0     成功
//   41700 需要验证（返回 policy，走上面 ②~④）
//   41701 许可提交被拒（换新挑战重走整条链路）
//   41702 限流/冷却（data.retry_after 秒后再试）
//   41709 协议版本不对（缺 X-Cloudreve-Captcha-Protocol: 2）
//   40026 旧「图形验证码」失败码（已无用，仍按验证失败处理）
//   40027 旧「PoW」失败码（已无用，仍按验证失败处理）
//   40020 账号或密码错误（终态）   40001 参数错误（终态）   401 未登录（终态）
//
// 成功判据（用户确认）：
//   离线下载是否成功，**只看目录（GET /directory）**里是否出现了全部期望文件、
//   且每个文件的 size 与 GitHub asset 的精确字节数一致。
//   不再查询 /aria2/finished，也不依赖任何 API 返回的 status / code 作为成败判据。
//
// 重试策略（用户确认）：见 config.mjs RETRY —— 「完整验证链路」按次重试，详见 verifyThenSend。

import { webcrypto } from 'node:crypto';

import { ENV, RETRY, TIMING, LIMIT } from './config.mjs';
import { log } from './log.mjs';

const BASE = ENV.HOST + '/api/v3';
const ORIGIN = ENV.HOST;

// 新版验证协议版本号；所有请求都要带（前端 axios 请求拦截器对每个请求都无条件加上）
const CAPTCHA_PROTOCOL = '2';

// ---------- 会话状态 ----------
// ⚠ 必须保存**全部 cookie**（见文件头 ⚠⚠）。旧实现只留 cloudreve-session 会让 policy 提交恒 41701。
const cookieJar = new Map(); // name -> value
let csrf = '';
let isLoggedIn = false;

export class H1Error extends Error {
  constructor(message) {
    super(message);
    this.name = 'H1Error';
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------- cookie / CSRF ----------
function cookieHeader() {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function saveSetCookie(res) {
  const lines = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : res.headers.get('set-cookie')
      ? [res.headers.get('set-cookie')]
      : [];
  for (const line of lines) {
    const m = /^\s*([^=;]+)=([^;]*)/.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    const val = m[2].trim();
    // 同名 cookie 以最后一次下发为准（会话轮换）
    if (name.toLowerCase() === 'cloudreve-session') cookieJar.set('cloudreve-session', val);
    else cookieJar.set(name, val);
  }
}

// 前端 axios 响应拦截器会从**任意**响应头里吸收最新的 x-csrf-token，这里保持一致
function saveCsrf(res) {
  const t = res.headers.get('x-csrf-token');
  if (typeof t === 'string' && t) csrf = t;
}

// ---------- 底层请求 ----------
async function api(method, path, body, extraHeaders = {}) {
  const headers = {
    Accept: 'application/json',
    'X-Cloudreve-Captcha-Protocol': CAPTCHA_PROTOCOL,
    ...extraHeaders,
  };
  const c = cookieHeader();
  if (c) headers.Cookie = c;
  if (method !== 'GET') {
    headers.Origin = ORIGIN;
    headers.Referer = ORIGIN + '/';
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
  saveCsrf(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { httpStatus: res.status, json, raw: text.slice(0, 300) };
}

// 写请求前先 GET /site/config 拿最新 CSRF token（实测该响应头必有 x-csrf-token）
async function apiWithToken(method, path, body, extraHeaders = {}) {
  const cf = await fetch(BASE + '/site/config', {
    headers: {
      Accept: 'application/json',
      'X-Cloudreve-Captcha-Protocol': CAPTCHA_PROTOCOL,
      ...(cookieHeader() ? { Cookie: cookieHeader() } : {}),
    },
    redirect: 'manual',
  });
  saveSetCookie(cf);
  saveCsrf(cf);
  if (!csrf) throw new H1Error('GET /site/config 未返回 x-csrf-token');
  return api(method, path, body, extraHeaders);
}

// 其他任何失败：最多重试（再尝试）N-1 次，默认 RETRY.GENERIC_ATTEMPTS 次尝试
async function genericAttempts(fn, label, attempts = RETRY.GENERIC_ATTEMPTS) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ---------- PoW（cloudreve-pow-v1，算法与上一版一致）----------
// 协议来源：前端 bundle / cloudreve-pow.*.worker.js 逆向 + 实测。

const POW_PROTOCOL = 'cloudreve-pow-v1'; // challenge.protocol 的取值（小写，用于校验）
const POW_ALGORITHM = 'PBKDF2-SHA-256';
// ⚠ 密码域分隔串是**大驼峰** "Cloudreve-PoW/v1"，与上面小写的协议标识**不是同一个字符串**
// （对应前端 worker 里的 protocolDomain 字节数组，末尾含 0x00）。两者混用会导致求解永远失败。
const POW_DOMAIN_STRING = 'Cloudreve-PoW/v1';
const POW_DOMAIN = Uint8Array.from(
  [...POW_DOMAIN_STRING, '\0'].map((c) => c.charCodeAt(0)),
);

function b64urlToBytes(value) {
  let s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return new Uint8Array(Buffer.from(s, 'base64'));
}

// 求解：逐 counter 试 PBKDF2-SHA256(password, salt||uint32_be(counter), iterations) == target
// 单线程（用户确认不引入 worker_threads），故带进度日志 + 硬超时，避免 GHA 里静默假死。
async function solvePow(challenge) {
  if (challenge.protocol !== POW_PROTOCOL || challenge.algorithm !== POW_ALGORITHM) {
    throw new H1Error(`PoW 协议不匹配：${challenge.protocol}/${challenge.algorithm}`);
  }
  const nonce = b64urlToBytes(challenge.nonce);
  const baseSalt = b64urlToBytes(challenge.salt);
  const target = b64urlToBytes(challenge.target);
  const iterations = Number(challenge.iterations);
  const counterLimit = Number(challenge.counterLimit);
  if (!nonce.length || !baseSalt.length || !target.length || !(iterations > 0) || !(counterLimit > 0)) {
    throw new H1Error('PoW 挑战字段非法');
  }
  const password = new Uint8Array(POW_DOMAIN.length + nonce.length);
  password.set(POW_DOMAIN, 0);
  password.set(nonce, POW_DOMAIN.length);
  const key = await webcrypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);

  // expiresAt 与自定义上限取小者作为硬超时
  const expiresMs = Number(challenge.expiresAt) > 0
    ? Number(challenge.expiresAt) * 1000 - Date.now()
    : Infinity;
  const budget = Math.min(RETRY.POW_SOLVE_TIMEOUT_MS, expiresMs);

  const t0 = Date.now();
  let lastLog = t0;
  for (let counter = 0; counter < counterLimit; counter += 1) {
    const salt = new Uint8Array(baseSalt.length + 4);
    salt.set(baseSalt, 0);
    new DataView(salt.buffer).setUint32(baseSalt.length, counter, false); // 大端
    const bits = new Uint8Array(await webcrypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      key,
      256,
    ));
    if (bits.length === target.length && bits.every((b, i) => b === target[i])) {
      if (counter > 0) {
        log.detail(`[PoW] 命中 counter=${counter}（试了 ${counter + 1} 个，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      }
      return counter;
    }
    const now = Date.now();
    if (now - t0 > budget) {
      throw new H1Error(`PoW 求解超时（${((now - t0) / 1000).toFixed(1)}s，已试 ${counter + 1}/${counterLimit}）`);
    }
    // 进度去抖：仅在间隔到达时输出（单线程求解可能数十秒，避免误以为卡死）
    if (now - lastLog >= TIMING.POW_PROGRESS_INTERVAL_MS) {
      lastLog = now;
      log.detail(`[PoW] 求解中… ${counter + 1}/${counterLimit}（${((now - t0) / 1000).toFixed(1)}s）`);
    }
  }
  return null; // counterLimit 内未找到（正常不会发生）
}

// ---------- 错误分类 ----------
// 需要走「验证链路」的码
const VERIFICATION_REQUIRED_CODES = new Set([41700]);
const VERIFICATION_FAILED_CODES = new Set([40026, 40027, 41701]);
const RATE_LIMITED_CODES = new Set([41702]);
// 重试也无意义的终态：凭据错误、未登录、参数错误等
const TERMINAL_CODES = new Set([40020, 40001, 401, 40007, 40008]);
// 我方实现问题（不该重试，应直接报错暴露）
const INTERNAL_CODES = new Set([41703, 41704, 41705]);

function isVerificationRequired(r) {
  return VERIFICATION_REQUIRED_CODES.has(r.json?.code);
}
function isVerificationFailure(r) {
  if (VERIFICATION_FAILED_CODES.has(r.json?.code)) return true;
  // 兜底：站点若改码但保留文案，仍能识别
  return /verification failed/i.test(String(r.json?.msg || ''));
}
function isRateLimited(r) {
  return RATE_LIMITED_CODES.has(r.json?.code);
}
function isTerminalFailure(r) {
  return TERMINAL_CODES.has(r.json?.code);
}
function isInternalFailure(r) {
  return INTERNAL_CODES.has(r.json?.code);
}
// 站点返回 code=0 但响应形状仍不满足 isSuccess（如取直链条数不足）→ 重试整条链路无意义
function isShapeMismatch(r, isSuccess) {
  return r.json?.code === 0 && !isSuccess(r);
}

// 41702 的 retry_after（秒）；缺省用 TIMING.COOLDOWN_DEFAULT_MS
function cooldownMs(r) {
  const sec = Number(r.json?.data?.retry_after ?? r.json?.retry_after);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : TIMING.COOLDOWN_DEFAULT_MS;
}

// ---------- 验证链路（挑战 → 许可）----------
// 对应前端 module 197 的 ensure() + axios 拦截器：
//   发请求 → 若 41700 则解 PoW 换许可 → 带 X-Cloudreve-Captcha-Permit 重发
// 返回 { ok, response }；链路耗尽时抛 H1Error。
//
// 分类策略（为了"绝不能因为站点小改动就全线失败"）：
//   成功                → 返回
//   41700 需要验证      → 走 PoW → policy → permit 重发
//   41701 许可被拒      → 换新挑战重走整条链路
//   41702 限流          → 按 retry_after 退避后重试
//   40026/40027 旧验证码→ 一并重试
//   终态(40020/40001/…) → 立即返回失败，日志给出明确原因（重试无意义）
async function verifyThenSend({ url, method = 'POST', buildBody, purpose, label, isSuccess = (r) => r.json?.code === 0 }) {
  let lastDetail = '';

  for (let attempt = 1; attempt <= RETRY.VERIFY_ATTEMPTS; attempt += 1) {
    let r;
    try {
      r = await genericAttempts(
        () => apiWithToken(method, url, buildBody ? buildBody() : undefined),
        `${label} 请求`,
      );
    } catch (e) {
      lastDetail = `请求异常：${e.message}`;
      continue;
    }

    if (isSuccess(r)) return { ok: true, response: r };
    if (isTerminalFailure(r)) {
      lastDetail = `终态错误 code=${r.json?.code}（${r.json?.msg || ''}），重试无意义`;
      return { ok: false, response: r };
    }
    if (isInternalFailure(r)) {
      throw new H1Error(`${label}内部错误 code=${r.json?.code}（${r.json?.msg || ''}）`);
    }
    if (isRateLimited(r)) {
      const wait = cooldownMs(r);
      lastDetail = `限流 code=41702，退避 ${(wait / 1000).toFixed(0)}s`;
      await sleep(wait);
      continue;
    }

    if (isVerificationRequired(r)) {
      // ---- ② 拿到 policy ----
      const policy = r.json?.data;
      if (!policy || typeof policy.id !== 'string') {
        lastDetail = '41700 响应缺少 policy.id';
        continue;
      }
      const required = policy.required || {};
      log.detail(`[${label}] 需要验证：purpose=${policy.purpose || purpose} interactive=${required.interactive ?? '?'} pow=${required.pow ?? '?'}`);

      // 交互式验证（滑块/点选）无法自动完成 —— 明确报错，不要静默重试 3 遍浪费几分钟
      if (Number(required.interactive) > 0 && !policy.interactive_done) {
        throw new H1Error(
          `${label}失败：站点要求交互式验证（interactive=${required.interactive}），无法自动完成，需人工处理`,
        );
      }

      if (!policy.pow || !policy.pow.token) {
        lastDetail = `41700 未提供 PoW 挑战（pow=${required.pow ?? '?'}）`;
        continue;
      }

      // ---- ③ 解 PoW 并提交换许可 ----
      let counter;
      try {
        counter = await solvePow(policy.pow);
        if (counter === null) throw new H1Error(`counterLimit(${policy.pow.counterLimit}) 内未找到答案`);
      } catch (e) {
        lastDetail = `PoW 求解失败：${e.message}`;
        continue;
      }

      let pr;
      try {
        pr = await genericAttempts(
          () => apiWithToken('POST', '/site/captcha/policy', {
            id: policy.id,
            pow_payload: JSON.stringify({ token: policy.pow.token, counter }),
          }),
          `${label} 提交许可`,
        );
      } catch (e) {
        lastDetail = `提交许可异常：${e.message}`;
        continue;
      }

      if (pr.json?.code !== 0) {
        if (isRateLimited(pr)) {
          const wait = cooldownMs(pr);
          lastDetail = `提交许可被限流，退避 ${(wait / 1000).toFixed(0)}s`;
          await sleep(wait);
        } else {
          lastDetail = `提交许可失败 code=${pr.json?.code}（${pr.json?.msg || pr.raw}）`;
        }
        continue;
      }

      // ---- ④ 带许可重发原请求 ----
      const permit = String(pr.json?.data?.id || policy.id);
      log.detail(`[${label}] 许可已获得，带许可重发`);
      try {
        r = await genericAttempts(
          () => apiWithToken(method, url, buildBody ? buildBody() : undefined, {
            'X-Cloudreve-Captcha-Permit': permit,
          }),
          `${label} 带许可重发`,
        );
      } catch (e) {
        lastDetail = `带许可重发异常：${e.message}`;
        continue;
      }

      // 走完链路后判断「是否只是响应形状不符」——这类失败重试整条链路毫无意义
      // （每次都要重新解一次几十秒的 PoW），直接抛出暴露问题。
      if (isSuccess(r)) {
        return { ok: true, response: r };
      }
      if (isShapeMismatch(r, isSuccess)) {
        throw new H1Error(
          `${label}失败：接口本身返回 code=0，但响应形状不符合预期（${JSON.stringify(r.json?.data)?.slice(0, 200)}）`,
        );
      }
      if (isTerminalFailure(r)) {
        lastDetail = `终态错误 code=${r.json?.code}（${r.json?.msg || ''}），重试无意义`;
        return { ok: false, response: r };
      }
      if (isRateLimited(r)) {
        const wait = cooldownMs(r);
        lastDetail = `限流 code=41702，退避 ${(wait / 1000).toFixed(0)}s`;
        await sleep(wait);
        continue;
      }
      // 又回到 41700 → 下一轮循环重走整条链路
      lastDetail = `带许可重发仍被要求验证 code=${r.json?.code}（${r.json?.msg || ''}）`;
      continue;
    }

    // 旧验证码失败码 / 其它未知错误：一并重试，不因站点换了个错误码就放弃
    if (isVerificationFailure(r)) {
      lastDetail = `验证失败 code=${r.json?.code}（${r.json?.msg || ''}）`;
    } else {
      lastDetail = `未知错误 HTTP ${r.httpStatus} code=${r.json?.code} ${r.json?.msg || r.raw}`;
    }
  }

  throw new H1Error(
    `${label}失败：完整验证链路 ${RETRY.VERIFY_ATTEMPTS} 次均未成功（${lastDetail}）`,
  );
}

// ---------- 登录（41700 → PoW → policy → permit 重试）----------
export async function login(user, password) {
  isLoggedIn = false;
  log.info('登录 huang1111…');
  const r = await verifyThenSend({
    url: '/user/session',
    buildBody: () => ({ userName: user, Password: password }),
    purpose: 'login',
    label: '登录',
  });
  if (!r.ok) {
    throw new H1Error(`登录失败：HTTP ${r.response.httpStatus} ${r.response.json?.msg || r.response.raw}`);
  }
  isLoggedIn = true;
  log.ok('登录成功');
}

// ---------- 目录 ----------
// netPath：不带前导斜杠的完整路径，如 `foldcraftlauncher_cn_auto/0/1/3/2/8`
export async function listDir(netPath) {
  const pathForApi = netPath.split('/').map(encodeURIComponent).join('/');
  const r = await genericAttempts(() => api('GET', '/directory/' + pathForApi), `列目录 ${netPath}`);
  if (r.json?.code === 40016) return { exists: false, objects: [] }; // 目录不存在
  if (r.json?.code !== 0) throw new H1Error(`列目录失败(HTTP ${r.httpStatus}): ${r.json?.msg || r.raw}`);
  return { exists: true, objects: r.json.data?.objects || [], parent: r.json.data?.parent };
}

// 幂等创建目录（PUT /directory 会连同中间目录一起创建）
export async function createDir(netPath) {
  const found = await listDir(netPath);
  if (found.exists) return found;
  log.detail(`[目录] 创建 /${netPath}`);
  const r = await genericAttempts(
    () => apiWithToken('PUT', '/directory', { path: '/' + netPath }),
    `建目录 ${netPath}`,
  );
  if (r.json?.code !== 0 && r.json?.code !== 40016) {
    // 40016 兜底：偶发竞态（刚创建完又查），视为已存在
    throw new H1Error(`建目录失败(HTTP ${r.httpStatus}): ${r.json?.msg || r.raw}`);
  }
  return listDir(netPath);
}

// ---------- 删除目录（Cloudreve DELETE /object，见 api-notes §5.2） ----------
// 目录进回收站（force:true 也不跳过，48h 自动清除）；需 CSRF，删除前先列目录拿目录自身 id
export async function deleteDir(netPath) {
  const found = await listDir(netPath);
  if (!found.exists) {
    return false;
  }
  const dirId = found.parent;
  if (!dirId) throw new H1Error(`删除目录失败：未取得目录 id（/${netPath}）`);
  log.detail(`[目录] 删除 /${netPath}`);
  const r = await genericAttempts(
    () => apiWithToken('DELETE', '/object', { items: [], dirs: [dirId], force: true }),
    `删除目录 ${netPath}`,
  );
  if (r.json?.code !== 0) throw new H1Error(`删除目录失败(HTTP ${r.httpStatus}): ${r.json?.msg || r.raw}`);

  // 向上清理空父目录：逐级检查上级目录是否已无任何对象，空则一并删除（含 foldcraftlauncher_cn_auto 根），
  // 直到遇到非空目录或没有更上层为止；避免 keepLatest 清理后残留一串空目录
  const segments = netPath.split('/').filter(Boolean);
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const parentPath = segments.slice(0, depth).join('/');
    const parent = await listDir(parentPath);
    if (!parent.exists) continue; // 上级已被删，继续往上
    if ((parent.objects || []).length > 0) break; // 上级非空，停止清理
    const pid = parent.parent;
    if (!pid) break;
    await genericAttempts(
      () => apiWithToken('DELETE', '/object', { items: [], dirs: [pid], force: true }),
      `删空父目录 ${parentPath}`,
    );
  }
  return true;
}

// ---------- 离线下载 ----------
// 收集正在下载中的任务（GET /aria2/downloading），返回匹配 dst 的文件名集合。
// 仅用于「重试时跳过已在下载中的文件」，不参与成败判定。
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

// urls: GitHub release asset 直链数组；wantFiles: [{ name, size }]，与 urls 一一对应
// 返回 Map<文件名, {id,size}>（取自目录，size 与期望精确相等）
// 成败只看 pollForFiles：目录里出现全部期望文件且 size 匹配
// 失败（提交或轮询超时）抛 H1Error
export async function offlineDownload(urls, netPath, wantFiles) {
  const dst = '/' + netPath; // 实测提交时 dst 带前导斜杠
  const wantNames = wantFiles.map((w) => w.name);
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY.DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      await createDir(netPath);

      // 1) 目录中已存在且 size 匹配 → 跳过提交
      const dirNow = await listDir(netPath);
      const existingOk = new Set();
      if (dirNow.exists) {
        const byName = new Map(
          dirNow.objects.filter((o) => o.type === 'file').map((o) => [o.name, o]),
        );
        for (const w of wantFiles) {
          const o = byName.get(w.name);
          if (o && Number(o.size) === Number(w.size)) existingOk.add(w.name);
        }
      }

      // 2) 已在下载中的任务 → 跳过重复提交（避免 xxx(1)）
      const downloadingNames = await collectDownloadingNames(dst, wantNames);

      // 3) 待提交列表（url ↔ file 成对，避免下标错位）
      const pending = [];
      for (let i = 0; i < wantFiles.length; i += 1) {
        const w = wantFiles[i];
        if (!existingOk.has(w.name) && !downloadingNames.has(w.name)) {
          pending.push({ url: urls[i], file: w });
        }
      }

      // 4) 分批提交：每批提交后轮询等待本批文件就绪，再提交下一批，
      //    确保任意时刻网盘并行任务数不超过 LIMIT.OFFLINE_BATCH
      if (pending.length > 0) {
        const totalBatches = Math.ceil(pending.length / LIMIT.OFFLINE_BATCH);
        for (let i = 0; i < pending.length; i += LIMIT.OFFLINE_BATCH) {
          const batch = pending.slice(i, i + LIMIT.OFFLINE_BATCH);
          const batchNo = Math.floor(i / LIMIT.OFFLINE_BATCH) + 1;
          log.detail(`[离线下载] 提交第 ${batchNo}/${totalBatches} 批（${batch.length} 个）`);
          await genericAttempts(
            () =>
              apiWithToken('POST', '/aria2/url', {
                url: batch.map((b) => b.url),
                dst,
                preferred_node: 0,
              }),
            '提交 aria2',
          );
          // 不因返回 code!==0 直接失败：可能"任务已存在/重复/部分 URL 失败"，
          // 真实状态由随后的目录轮询决定
          await pollForFiles(netPath, batch.map((b) => b.file));
        }
      }

      // 5) 最终全量确认（含之前已在下载的 + 本次各批新下载的）
      return await pollForFiles(netPath, wantFiles, { final: true });
    } catch (e) {
      lastErr = e;
      if (attempt < RETRY.DOWNLOAD_ATTEMPTS) await sleep(3000); // 下次提交前稍等
    }
  }
  throw new H1Error(`离线下载失败：${RETRY.DOWNLOAD_ATTEMPTS} 次均未成功（${lastErr?.message || ''}）`);
}

// 轮询：唯一成功判据 —— 目录里出现全部期望文件，且 size 精确相等。
// 不再查询 /aria2/finished，也不依赖任何 API 的 status/code 作为成败判据。
// wantFiles: [{ name, size }]，返回 Map<文件名, {id,size}>
// final=true 时（全量确认）在就绪后输出一条成功日志；批次轮询只做去重进度输出
async function pollForFiles(netPath, wantFiles, { final = false } = {}) {
  const total = wantFiles.length;
  const deadline = Date.now() + ENV.DOWNLOAD_TIMEOUT_MS;
  let lastMatched = -1;
  while (Date.now() < deadline) {
    let dir;
    try {
      dir = await listDir(netPath);
    } catch {
      dir = { exists: false, objects: [] }; // 轮询中的瞬时失败，继续等
    }
    if (dir.exists) {
      const byName = new Map();
      for (const o of dir.objects) {
        if (o.type === 'file') byName.set(o.name, o);
      }
      const matched = new Map();
      for (const w of wantFiles) {
        const o = byName.get(w.name);
        if (!o) continue;
        if (Number(o.size) === Number(w.size)) {
          matched.set(w.name, { id: o.id, size: o.size });
        }
      }
      // 进度去抖：仅在"已就绪数量"变化时输出，避免每 5s 刷屏
      if (matched.size !== lastMatched) {
        lastMatched = matched.size;
        log.detail(`[离线下载] 轮询中：${matched.size}/${total} 个文件已就绪`);
      }
      if (matched.size === total) {
        if (final) log.ok(`[离线下载] ${total} 个文件已就绪`);
        return matched;
      }
    }
    await sleep(TIMING.POLL_INTERVAL_MS);
  }
  throw new H1Error(
    `轮询超时(${Math.round(ENV.DOWNLOAD_TIMEOUT_MS / 1000)}s)：${netPath} 未出现全部期望文件（含 size 校验）`,
  );
}

// ---------- 批量取直链（41700 → PoW → policy → permit 重试）----------
// fileIds: 文件 id 数组；返回 [{id,url,name}]
export async function getSources(fileIds) {
  const r = await verifyThenSend({
    url: '/file/source',
    buildBody: () => ({ items: fileIds }),
    purpose: 'direct_link',
    label: '取直链',
    // 直链额外要求：返回条数与请求一致（与改造前判据相同）
    isSuccess: (x) =>
      x.json?.code === 0 && Array.isArray(x.json.data) && x.json.data.length === fileIds.length,
  });
  if (!r.ok) {
    throw new H1Error(`取直链失败：HTTP ${r.response.httpStatus} ${r.response.json?.msg || r.response.raw}`);
  }
  log.detail(`[取直链] 成功（${fileIds.length} 个文件）`);
  return r.response.json.data;
}

export function isAuthed() {
  return isLoggedIn;
}
