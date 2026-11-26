// config.mjs — 本地托盘版配置：默认值、校验、旧版迁移、原子保存
//
// 契约见 local/PROTOCOL.md §4：
//   · 字段名/嵌套结构固定；缺失字段补默认值；类型或枚举非法 → 报错，绝不静默清空用户设置
//   · 允许明文凭据（用户明确要求可迁移），但调用方必须保证不把凭据写进日志/状态/命令行
//   · 保存 = 临时文件写入 + rename 覆盖；任何一步失败都保留原文件
//   · 旧版扁平 config.json（intervalMinutes / session / …）自动迁移到 v1，迁移前先备份

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CONFIG_FILE } from './paths.mjs';

export const CONFIG_VERSION = 1;

/** 默认配置（同时也是「补齐缺失字段」的来源） */
export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    runtime: { nodePath: '', syncTimeoutMinutes: 120, pullTimeoutMinutes: 10, pushTimeoutMinutes: 5 },
    startup: { enabled: false, runOnStart: true },
    scheduler: { intervalMinutes: 10, catchUpOnWake: true },
    wifi: {
      enabled: false,
      ssid: '',
      password: '',
      useSavedFirst: true,
      alwaysConnect: false,
      skipOnFailure: true,
      disconnectAfter: false,
      disconnectEvenOnFailure: true,
      forgetOnDisconnect: false,
    },
    stages: {
      pull: { enabled: true, strategy: 'rebase' },
      sync: { enabled: true },
      commit: { enabled: true, identityMode: 'gha', userName: '', userEmail: '' },
      push: { enabled: true },
    },
    credentials: { H1111_SESSION: '', H1111_USER: '', H1111_PASSWORD: '', GH_TOKEN: '', PUSH_TOKEN: '' },
    notifications: {
      mode: 'standard',
      standard: { success: true, 'up-to-date': false, failure: true, 'internal-error': true },
      cumulative: { everyRuns: 7, internalErrorMode: 'always' },
    },
    appearance: { iconPath: null },
    logging: { retentionDays: 90 },
    security: { lockPassword: '' },
  };
}

// ---------- 取值/赋值小工具 ----------

function getPath(obj, dotted) {
  return dotted.split('.').reduce((cur, key) => (cur && typeof cur === 'object' ? cur[key] : undefined), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** 字段表：类型 + 范围/枚举 + 可读名称（错误信息里用） */
const FIELDS = [
  ['runtime.nodePath', 'string', { label: 'Node 路径' }],
  ['runtime.syncTimeoutMinutes', 'int', { min: 1, max: 1440, label: '同步超时（分钟）' }],
  ['runtime.pullTimeoutMinutes', 'int', { min: 1, max: 120, label: 'Pull 超时（分钟）' }],
  ['runtime.pushTimeoutMinutes', 'int', { min: 1, max: 60, label: 'Push 超时（分钟）' }],

  ['startup.enabled', 'bool', { label: '开机自启动' }],
  ['startup.runOnStart', 'bool', { label: '启动后立即同步' }],

  ['scheduler.intervalMinutes', 'int', { min: 1, max: 1440, label: '同步间隔（分钟）' }],
  ['scheduler.catchUpOnWake', 'bool', { label: '唤醒后补跑' }],

  ['wifi.enabled', 'bool', { label: 'WiFi 管理' }],
  ['wifi.ssid', 'string', { label: 'WiFi 名称' }],
  ['wifi.password', 'string', { label: 'WiFi 密码' }],
  ['wifi.useSavedFirst', 'bool', { label: '优先使用系统已保存密码' }],
  ['wifi.alwaysConnect', 'bool', { label: '总是尝试连接' }],
  ['wifi.skipOnFailure', 'bool', { label: '连接失败时跳过整次同步' }],
  ['wifi.disconnectAfter', 'bool', { label: '同步后断开 WiFi' }],
  ['wifi.disconnectEvenOnFailure', 'bool', { label: '同步失败也断开' }],
  ['wifi.forgetOnDisconnect', 'bool', { label: '断开后忘记配置' }],

  ['stages.pull.enabled', 'bool', { label: 'Pull 阶段' }],
  ['stages.pull.strategy', 'enum', { values: ['rebase', 'ff-only'], label: 'Pull 策略' }],
  ['stages.sync.enabled', 'bool', { label: 'Sync 阶段' }],
  ['stages.commit.enabled', 'bool', { label: 'Commit 阶段' }],
  ['stages.commit.identityMode', 'enum', { values: ['gha', 'default', 'custom'], label: 'Git 身份模式' }],
  ['stages.commit.userName', 'string', { label: 'Git 用户名' }],
  ['stages.commit.userEmail', 'string', { label: 'Git 邮箱' }],
  ['stages.push.enabled', 'bool', { label: 'Push 阶段' }],

  ['credentials.H1111_SESSION', 'string', { label: 'H1111_SESSION' }],
  ['credentials.H1111_USER', 'string', { label: 'H1111_USER' }],
  ['credentials.H1111_PASSWORD', 'string', { label: 'H1111_PASSWORD' }],
  ['credentials.GH_TOKEN', 'string', { label: 'GH_TOKEN' }],
  ['credentials.PUSH_TOKEN', 'string', { label: 'PUSH_TOKEN' }],

  ['notifications.mode', 'enum', { values: ['standard', 'cumulative'], label: '通知模式' }],
  ['notifications.standard.success', 'bool', { label: '通知：成功' }],
  ['notifications.standard.up-to-date', 'bool', { label: '通知：已是最新' }],
  ['notifications.standard.failure', 'bool', { label: '通知：失败' }],
  ['notifications.standard.internal-error', 'bool', { label: '通知：内部错误' }],
  ['notifications.cumulative.everyRuns', 'int', { min: 1, max: 100, label: '累积通知次数' }],
  ['notifications.cumulative.internalErrorMode', 'enum', { values: ['always', 'never'], label: '内部错误始终通知' }],

  ['appearance.iconPath', 'stringOrNull', { label: '托盘图标路径' }],

  ['logging.retentionDays', 'int', { min: 0, max: 3650, label: '日志保留天数' }],
  ['security.lockPassword', 'string', { label: '锁定密码' }],
];

function coerceBool(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return undefined;
}

/**
 * 校验 + 归一化。缺失字段补默认值，非法字段收集错误（保留原值不动，由调用方决定是否拒绝保存）。
 * @returns {{ config: object, errors: string[], warnings: string[] }}
 */
export function normalizeConfig(input) {
  const base = defaultConfig();
  const config = defaultConfig();
  const errors = [];
  const warnings = [];
  const src = input && typeof input === 'object' ? input : {};

  for (const [dotted, type, rules] of FIELDS) {
    const raw = getPath(src, dotted);
    const fallback = getPath(base, dotted);
    const label = rules.label || dotted;

    if (raw === undefined || raw === null) {
      // appearance.iconPath 允许 null 表示「未自定义」
      if (type === 'stringOrNull') setPath(config, dotted, null);
      else if (type === 'bool') setPath(config, dotted, fallback);
      else setPath(config, dotted, fallback);
      if (raw === undefined) warnings.push(`缺少字段 ${dotted}，已用默认值`);
      continue;
    }

    if (type === 'bool') {
      const v = coerceBool(raw);
      if (v === undefined) { errors.push(`${label}（${dotted}）必须是布尔值`); setPath(config, dotted, fallback); }
      else setPath(config, dotted, v);
      continue;
    }

    if (type === 'int') {
      const v = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(v) || !Number.isInteger(v)) { errors.push(`${label}（${dotted}）必须是整数`); setPath(config, dotted, fallback); continue; }
      if (rules.min !== undefined && v < rules.min) { errors.push(`${label}（${dotted}）不能小于 ${rules.min}`); setPath(config, dotted, fallback); continue; }
      if (rules.max !== undefined && v > rules.max) { errors.push(`${label}（${dotted}）不能大于 ${rules.max}`); setPath(config, dotted, fallback); continue; }
      setPath(config, dotted, v);
      continue;
    }

    if (type === 'enum') {
      const v = String(raw).trim();
      if (!rules.values.includes(v)) {
        errors.push(`${label}（${dotted}）只能是 ${rules.values.join(' / ')}，当前是「${v}」`);
        setPath(config, dotted, fallback);
      } else setPath(config, dotted, v);
      continue;
    }

    if (type === 'stringOrNull') {
      const v = String(raw).trim();
      setPath(config, dotted, v || null);
      continue;
    }

    // string
    setPath(config, dotted, String(raw));
  }

  const cfg = config;
  cfg.version = CONFIG_VERSION;

  // 百分比/组合约束
  if (cfg.stages.commit.identityMode === 'custom') {
    const { userName, userEmail } = cfg.stages.commit;
    if (!userName.trim()) errors.push('自定义 Git 身份时用户名不能为空');
    if (!userEmail.trim()) errors.push('自定义 Git 身份时邮箱不能为空');
    else if (!/^[^\s@]+@[^\s@]+$/.test(userEmail.trim())) errors.push('Git 邮箱格式不正确');
  }
  if (cfg.wifi.enabled && !cfg.wifi.ssid.trim()) {
    warnings.push('WiFi 管理已启用但未填写 WiFi 名称，本轮会直接跳过 WiFi 处理');
  }
  if (cfg.startup.enabled && !cfg.security.lockPassword) {
    // 仅提示，不阻止
    warnings.push('已开启开机自启动，但未设置锁定密码');
  }

  return { config: cfg, errors, warnings };
}

// ---------- 旧版配置迁移（v0 扁平结构 → v1） ----------

const LEGACY_KEYS = ['intervalMinutes', 'runOnStart', 'session', 'githubToken', 'gitToken', 'stepPull', 'notifyMode', 'iconPath', 'logRetentionDays', 'pullBeforeSync'];

export function isLegacyConfig(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (Number(raw.version) === CONFIG_VERSION) return false;
  return LEGACY_KEYS.some((k) => raw[k] !== undefined);
}

function legacyNotify(raw) {
  const mode = String(raw.notifyMode || 'always').toLowerCase();
  const everyRuns = Number(raw.notifyEveryRuns) > 0 ? Math.min(100, Math.floor(Number(raw.notifyEveryRuns))) : 7;
  if (mode === 'accumulate') {
    return {
      mode: 'cumulative',
      standard: { success: true, 'up-to-date': false, failure: true, 'internal-error': true },
      cumulative: { everyRuns, internalErrorMode: 'always' },
    };
  }
  if (mode === 'failure') {
    return {
      mode: 'standard',
      standard: { success: false, 'up-to-date': false, failure: true, 'internal-error': true },
      cumulative: { everyRuns, internalErrorMode: 'always' },
    };
  }
  if (mode === 'never') {
    return {
      mode: 'standard',
      standard: { success: false, 'up-to-date': false, failure: false, 'internal-error': false },
      cumulative: { everyRuns, internalErrorMode: 'never' },
    };
  }
  // always（旧默认）
  return {
    mode: 'standard',
    standard: { success: true, 'up-to-date': true, failure: true, 'internal-error': true },
    cumulative: { everyRuns, internalErrorMode: 'always' },
  };
}

function legacyIdentity(raw) {
  const mode = String(raw.gitIdentityMode || 'script').toLowerCase();
  if (mode === 'git') return { identityMode: 'default', userName: '', userEmail: '' };
  if (mode === 'custom') {
    return { identityMode: 'custom', userName: String(raw.gitUserName || ''), userEmail: String(raw.gitUserEmail || '') };
  }
  return { identityMode: 'gha', userName: '', userEmail: '' };
}

/**
 * 把旧版扁平配置翻译成 v1（不写盘、不改文件）。
 * 说明：旧版 iconPath 指向用户原始图片，迁移时会把图片复制进 assets/（由调用方完成）。
 */
export function migrateLegacyConfig(raw) {
  const cfg = defaultConfig();
  const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);

  cfg.scheduler.intervalMinutes = Math.min(1440, num(raw.intervalMinutes, cfg.scheduler.intervalMinutes));
  cfg.startup.runOnStart = raw.runOnStart === undefined ? cfg.startup.runOnStart : coerceBool(raw.runOnStart) === true;
  cfg.runtime.nodePath = String(raw.nodePath || '');
  cfg.runtime.syncTimeoutMinutes = Math.min(1440, num(raw.syncTimeoutMinutes, cfg.runtime.syncTimeoutMinutes));
  cfg.runtime.pullTimeoutMinutes = Math.min(120, num(raw.pullTimeoutMinutes, cfg.runtime.pullTimeoutMinutes));

  cfg.credentials.H1111_SESSION = String(raw.session || '');
  cfg.credentials.H1111_USER = String(raw.h1111User || raw.user || '');
  cfg.credentials.H1111_PASSWORD = String(raw.h1111Password || raw.password || '');
  cfg.credentials.GH_TOKEN = String(raw.githubToken || '');
  cfg.credentials.PUSH_TOKEN = String(raw.gitToken || '');

  cfg.stages.pull.enabled = (raw.pullBeforeSync !== false) && (raw.stepPull !== false);
  cfg.stages.pull.strategy = String(raw.pullStrategy || '').toLowerCase() === 'ff-only' ? 'ff-only' : 'rebase';
  cfg.stages.sync.enabled = raw.stepSync !== false;
  cfg.stages.commit.enabled = raw.stepCommit !== false;
  cfg.stages.push.enabled = raw.stepPush !== false;
  Object.assign(cfg.stages.commit, legacyIdentity(raw));

  cfg.notifications = legacyNotify(raw);
  cfg.logging.retentionDays = Number.isFinite(Number(raw.logRetentionDays))
    ? Math.max(0, Math.min(3650, Math.floor(Number(raw.logRetentionDays))))
    : cfg.logging.retentionDays;
  cfg.security.lockPassword = String(raw.lockPassword || '');
  // 旧版指向用户原始图片的绝对路径：先原样带着，由 main.mjs 复制进 assets/ 后改成相对路径
  cfg.appearance.iconPath = raw.iconPath ? String(raw.iconPath) : null;

  return cfg;
}

// ---------- 读写 ----------

function timestampSuffix(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** 备份一个文件（失败只返回 null，不抛） */
export function backupFile(file, label = 'bak') {
  try {
    if (!fs.existsSync(file)) return null;
    const dest = `${file}.${label}-${timestampSuffix()}`;
    fs.copyFileSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

/** 原子写入：临时文件 → rename 覆盖；失败时原文件保持不动 */
export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, error: null };
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * 读取配置。首次运行生成默认配置；损坏时备份并恢复默认；旧版自动迁移。
 * @returns {{ ok: boolean, config: object, errors: string[], warnings: string[], created: boolean, recovered: boolean, migrated: boolean, backup: string|null }}
 */
export function loadConfig(file = CONFIG_FILE) {
  const result = {
    ok: true, config: defaultConfig(), errors: [], warnings: [],
    created: false, recovered: false, migrated: false, backup: null,
  };

  let raw = null;
  let text = null;
  try {
    // 编辑器/PowerShell 5.1 可能写 UTF-8 BOM，JSON.parse 不认，先剥掉
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const { config } = normalizeConfig(defaultConfig());
      const saved = saveConfig(config, file);
      result.config = config;
      result.created = true;
      result.ok = saved.ok;
      if (!saved.ok) result.errors.push(`无法创建默认配置：${saved.error}`);
      return result;
    }
    result.ok = false;
    result.errors.push(`无法读取配置文件：${e && e.message ? e.message : e}`);
    return result;
  }

  try {
    raw = JSON.parse(text);
  } catch (e) {
    // 损坏：先备份，再恢复默认；绝不静默清空
    result.backup = backupFile(file, 'corrupt');
    result.recovered = true;
    const { config } = normalizeConfig(defaultConfig());
    saveConfig(config, file);
    result.config = config;
    result.ok = false;
    result.errors.push(`配置文件损坏，已备份为 ${path.basename(result.backup || file)} 并恢复默认配置：${e && e.message ? e.message : e}`);
    return result;
  }

  // 旧版迁移
  if (isLegacyConfig(raw)) {
    result.backup = backupFile(file, 'legacy');
    const migrated = migrateLegacyConfig(raw);
    const normalized = normalizeConfig(migrated);
    result.config = normalized.config;
    result.migrated = true;
    result.warnings.push(...normalized.warnings);
    const saved = saveConfig(result.config, file);
    if (!saved.ok) {
      result.ok = false;
      result.errors.push(`旧版配置迁移后保存失败：${saved.error}`);
    }
    return result;
  }

  const normalized = normalizeConfig(raw);
  result.config = normalized.config;
  result.errors.push(...normalized.errors);
  result.warnings.push(...normalized.warnings);
  result.ok = normalized.errors.length === 0;

  // 补齐缺失字段后顺手回写（只在确有变化且有能力时）
  if (result.ok && normalized.warnings.some((w) => w.startsWith('缺少字段'))) {
    saveConfig(result.config, file);
  }
  return result;
}

/** 校验并保存配置（不校验就不写盘） */
export function saveConfig(config, file = CONFIG_FILE) {
  const { config: normalized, errors } = normalizeConfig(config);
  if (errors.length) return { ok: false, error: errors.join('；'), config: normalized, errors };
  const written = writeJsonAtomic(file, normalized);
  if (!written.ok) return { ok: false, error: written.error, config: normalized, errors: [] };
  return { ok: true, error: null, config: normalized, errors: [] };
}

/**
 * 恢复默认配置（先备份现有文件，绝不静默丢掉用户设置）。
 * 目前没有接 UI（设计只要求「配置模块具备恢复默认能力」）；命令行/排障时可手动调用。
 * @returns {{ok:boolean, config:object, backup:string|null, error:string|null}}
 */
export function resetConfig(file = CONFIG_FILE) {
  const backup = backupFile(file, 'before-reset');
  const { config } = normalizeConfig(defaultConfig());
  const saved = saveConfig(config, file);
  return {
    ok: saved.ok,
    config: saved.config || config,
    backup,
    error: saved.ok ? null : saved.error,
  };
}

/** 收集需要在日志里脱敏的配置值 */export function secretsOf(config) {
  const c = config || {};
  const creds = c.credentials || {};
  return [
    creds.H1111_SESSION, creds.H1111_USER, creds.H1111_PASSWORD, creds.GH_TOKEN, creds.PUSH_TOKEN,
    (c.wifi || {}).password, (c.security || {}).lockPassword,
  ].filter((v) => typeof v === 'string' && v.length > 0);
}

/**
 * 尽可能收紧配置文件权限（只对当前用户 + SYSTEM + 管理员可读）。
 * 便携性要求下不能加密，只能靠 ACL 减少被其它普通用户读取的机会。失败只记日志。
 */
export function restrictFileAcl(file = CONFIG_FILE) {
  try {
    const user = process.env.USERNAME || '';
    if (!user) return { ok: false, error: '无法获取当前用户名' };
    const r = spawnSync('icacls', [
      file, '/inheritance:r',
      '/grant:r', `${user}:(F)`,
      '/grant:r', '*S-1-5-18:(F)',   // SYSTEM
      '/grant:r', '*S-1-5-32-544:(F)', // Administrators
    ], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    return { ok: r.status === 0, error: r.status === 0 ? null : (r.stderr || '').trim() };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

export { CONFIG_FILE };
