// config.test.mjs — 配置默认值 / 校验 / 旧版迁移 / 原子保存
//
// 对应设计文档 §20.1「配置测试」与 PROTOCOL.md §4（schema v1）、§4.1（旧版迁移）：
//   · 首次启动生成默认配置
//   · 缺少字段时补齐默认值（并给 warning，不静默）
//   · 类型/枚举非法 → 可读中文错误、不抛异常、不静默清空用户设置
//   · 损坏配置 → 备份 + 恢复默认，绝不静默清空
//   · 写入中断时原配置保留（原子写）
// 所有读写都在 os.tmpdir() 下的临时目录里做，**绝不碰真实 local/config.json**。

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONFIG_VERSION,
  defaultConfig,
  normalizeConfig,
  isLegacyConfig,
  migrateLegacyConfig,
  loadConfig,
  saveConfig,
  writeJsonAtomic,
  secretsOf,
} from '../modules/config.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fdn-cfg-'));
let caseSeq = 0;

/** 每个用例一个独立目录，互不影响 */
function freshFile(name = 'config.json') {
  caseSeq += 1;
  const dir = path.join(tmpRoot, `case-${caseSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listDir(file) {
  return fs.readdirSync(path.dirname(file));
}

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §20.1 默认配置
// ---------------------------------------------------------------------------

describe('defaultConfig（PROTOCOL §4 默认结构）', () => {
  test('结构完整、字段值与契约一致', () => {
    const cfg = defaultConfig();
    assert.equal(cfg.version, CONFIG_VERSION);
    assert.equal(CONFIG_VERSION, 1);
    assert.deepEqual(Object.keys(cfg).sort(), [
      'appearance', 'credentials', 'logging', 'notifications', 'runtime',
      'scheduler', 'security', 'stages', 'startup', 'version', 'wifi',
    ]);

    // runtime
    assert.deepEqual(cfg.runtime, {
      nodePath: '', syncTimeoutMinutes: 120, pullTimeoutMinutes: 10, pushTimeoutMinutes: 5,
    });
    // startup
    assert.deepEqual(cfg.startup, { enabled: false, runOnStart: true });
    // scheduler
    assert.deepEqual(cfg.scheduler, { intervalMinutes: 10, catchUpOnWake: true });
    // wifi（10 个开关）
    assert.deepEqual(cfg.wifi, {
      enabled: false,
      ssid: '',
      password: '',
      useSavedFirst: true,
      alwaysConnect: false,
      skipOnFailure: true,
      disconnectAfter: false,
      disconnectEvenOnFailure: true,
      forgetOnDisconnect: false,
    });
    // stages
    assert.deepEqual(cfg.stages, {
      pull: { enabled: true, strategy: 'rebase' },
      sync: { enabled: true },
      commit: { enabled: true, identityMode: 'gha', userName: '', userEmail: '' },
      push: { enabled: true },
    });
    // credentials：五个凭据位全为空串（不预填任何假值）
    assert.deepEqual(cfg.credentials, {
      H1111_SESSION: '', H1111_USER: '', H1111_PASSWORD: '', GH_TOKEN: '', PUSH_TOKEN: '',
    });
    // notifications：默认 standard 模式，四项勾选与契约一致（up-to-date 默认关）
    assert.deepEqual(cfg.notifications, {
      mode: 'standard',
      standard: { success: true, 'up-to-date': false, failure: true, 'internal-error': true },
      cumulative: { everyRuns: 7, internalErrorMode: 'always' },
    });
    assert.equal(cfg.appearance.iconPath, null);
    assert.equal(cfg.logging.retentionDays, 90);
    assert.equal(cfg.security.lockPassword, '');
  });

  test('每次返回新对象（互不共享引用）', () => {
    const a = defaultConfig();
    a.scheduler.intervalMinutes = 999;
    a.credentials.GH_TOKEN = 'MUTATED';
    const b = defaultConfig();
    assert.equal(b.scheduler.intervalMinutes, 10);
    assert.equal(b.credentials.GH_TOKEN, '');
  });
});

// ---------------------------------------------------------------------------
// §20.1 补齐缺失字段
// ---------------------------------------------------------------------------

describe('normalizeConfig 补齐缺失字段（PROTOCOL §4「缺少字段一律补默认值」）', () => {
  test('空对象 → 全部补默认值，诱因写成可读 warning，不产生 error', () => {
    const { config, errors, warnings } = normalizeConfig({});
    assert.deepEqual(errors, []);
    assert.deepEqual(config, defaultConfig());
    // FIELDS 表里 40 个字段全部缺失 → 每个字段一条 warning
    assert.equal(warnings.length, 40);
    assert.ok(warnings.every((w) => w.startsWith('缺少字段 ')), '所有 warning 应说明缺了哪个字段');
    assert.ok(warnings.includes('缺少字段 scheduler.intervalMinutes，已用默认值'));
    assert.ok(warnings.includes('缺少字段 credentials.GH_TOKEN，已用默认值'));
    assert.ok(warnings.includes('缺少字段 appearance.iconPath，已用默认值'));
  });

  test('部分缺字段：已给出的值保留，缺的补默认，warning 只针对缺的', () => {
    const { config, errors, warnings } = normalizeConfig({ scheduler: { intervalMinutes: 15 } });
    assert.deepEqual(errors, []);
    assert.equal(config.scheduler.intervalMinutes, 15, '用户给的 15 不能被默认值覆盖');
    assert.equal(config.scheduler.catchUpOnWake, true, '同组缺失字段也要补默认');
    assert.ok(!warnings.includes('缺少字段 scheduler.intervalMinutes，已用默认值'));
    assert.ok(warnings.includes('缺少字段 scheduler.catchUpOnWake，已用默认值'));
  });

  test('未知字段被丢弃（不污染配置结构）', () => {
    const { config } = normalizeConfig({ foo: 'bar', scheduler: { intervalMinutes: 5, bogus: 1 } });
    assert.equal(config.foo, undefined);
    assert.equal(config.scheduler.bogus, undefined);
    assert.equal(config.scheduler.intervalMinutes, 5);
  });

  test('数字字符串（设置窗口回传）按整数接受', () => {
    const { config, errors } = normalizeConfig({ scheduler: { intervalMinutes: '12' } });
    assert.deepEqual(errors, []);
    assert.equal(config.scheduler.intervalMinutes, 12);
    assert.equal(typeof config.scheduler.intervalMinutes, 'number');
  });
});

// ---------------------------------------------------------------------------
// §20.1 非法枚举 / 非整数 / 超范围
// ---------------------------------------------------------------------------

describe('normalizeConfig 非法输入：可读中文错误、不抛异常、不静默清空', () => {
  test('非法枚举值：报错并保留可读提示（含合法取值）', () => {
    const cases = [
      [{ stages: { pull: { strategy: 'merge' } } }, 'Pull 策略', ['rebase', 'ff-only'], 'stages.pull.strategy'],
      [{ stages: { commit: { identityMode: 'script' } } }, 'Git 身份模式', ['gha', 'default', 'custom'], 'stages.commit.identityMode'],
      [{ notifications: { mode: 'always' } }, '通知模式', ['standard', 'cumulative'], 'notifications.mode'],
      [{ notifications: { cumulative: { internalErrorMode: 'sometimes' } } }, '内部错误始终通知', ['always', 'never'], 'notifications.cumulative.internalErrorMode'],
    ];
    for (const [input, label, values, dotted] of cases) {
      const { errors } = normalizeConfig(input); // 不得抛异常
      assert.equal(errors.length, 1, `${dotted} 应产生且只产生一条错误`);
      const msg = errors[0];
      assert.ok(msg.includes(label), `错误信息应含字段中文名「${label}」：${msg}`);
      assert.ok(msg.includes(dotted), `错误信息应含字段路径「${dotted}」：${msg}`);
      for (const v of values) assert.ok(msg.includes(v), `错误信息应列出合法取值「${v}」：${msg}`);
    }
  });

  test('非整数值：报「必须是整数」，且不抛异常', () => {
    for (const raw of [2.5, 'abc', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      const { errors } = normalizeConfig({ scheduler: { intervalMinutes: raw } });
      assert.equal(errors.length, 1, `${String(raw)} 应报错`);
      assert.match(errors[0], /同步间隔（分钟）（scheduler\.intervalMinutes）必须是整数/);
    }
  });

  test('超出范围：报「不能小于 / 不能大于」，并给出边界值', () => {
    const tooSmall = normalizeConfig({ scheduler: { intervalMinutes: 0 } });
    assert.equal(tooSmall.errors.length, 1);
    assert.match(tooSmall.errors[0], /不能小于 1/);

    const tooBig = normalizeConfig({ scheduler: { intervalMinutes: 2000 } });
    assert.equal(tooBig.errors.length, 1);
    assert.match(tooBig.errors[0], /不能大于 1440/);

    const negRetention = normalizeConfig({ logging: { retentionDays: -1 } });
    assert.match(negRetention.errors[0], /日志保留天数.*不能小于 0/);

    const bigEvery = normalizeConfig({ notifications: { cumulative: { everyRuns: 101 } } });
    assert.match(bigEvery.errors[0], /累积通知次数.*不能大于 100/);
  });

  test('非法值不再写回配置（回落到默认值，绝不出现 undefined/NaN）', () => {
    const { config } = normalizeConfig({
      scheduler: { intervalMinutes: 'abc' },
      notifications: { mode: 'nope' },
      startup: { enabled: 'yes' },
    });
    assert.equal(config.scheduler.intervalMinutes, 10);
    assert.equal(config.notifications.mode, 'standard');
    assert.equal(config.startup.enabled, false);
    for (const v of [config.scheduler.intervalMinutes, config.notifications.cumulative.everyRuns]) {
      assert.equal(Number.isInteger(v), true);
    }
  });

  test('布尔强制转换：\'true\'/1 → true，\'false\'/0 → false，其它值报错', () => {
    assert.equal(normalizeConfig({ startup: { enabled: 'true' } }).config.startup.enabled, true);
    assert.equal(normalizeConfig({ startup: { enabled: 1 } }).config.startup.enabled, true);
    assert.equal(normalizeConfig({ startup: { runOnStart: 'false' } }).config.startup.runOnStart, false);
    assert.equal(normalizeConfig({ startup: { runOnStart: 0 } }).config.startup.runOnStart, false);
    const bad = normalizeConfig({ startup: { enabled: 'yes' } });
    assert.equal(bad.errors.length, 1);
    assert.match(bad.errors[0], /开机自启动（startup\.enabled）必须是布尔值/);
    assert.equal(bad.config.startup.enabled, false);
  });

  test('凭据是字符串字段：不清空、原样保留（允许明文迁移）', () => {
    const { config, errors } = normalizeConfig({
      credentials: { H1111_SESSION: 'FAKE-SESSION-VALUE', GH_TOKEN: 'FAKE-TOKEN', PUSH_TOKEN: 'FAKE-PUSH' },
    });
    assert.deepEqual(errors, []);
    assert.equal(config.credentials.H1111_SESSION, 'FAKE-SESSION-VALUE');
    assert.equal(config.credentials.GH_TOKEN, 'FAKE-TOKEN');
    assert.equal(config.credentials.PUSH_TOKEN, 'FAKE-PUSH');
    assert.equal(config.credentials.H1111_USER, '');
  });
});

// ---------------------------------------------------------------------------
// appearance.iconPath 特殊规则
// ---------------------------------------------------------------------------

describe('appearance.iconPath（PROTOCOL §4：相对 local/ 的副本路径）', () => {
  test('空串 / 纯空白 → null（表示未自定义）', () => {
    assert.equal(normalizeConfig({ appearance: { iconPath: '' } }).config.appearance.iconPath, null);
    assert.equal(normalizeConfig({ appearance: { iconPath: '   ' } }).config.appearance.iconPath, null);
    assert.equal(normalizeConfig({ appearance: { iconPath: null } }).config.appearance.iconPath, null);
  });

  test('相对路径原样保留（不加绝对前缀、不改成反斜杠）', () => {
    const rel = 'assets/user-icon.png';
    const { config } = normalizeConfig({ appearance: { iconPath: rel } });
    assert.equal(config.appearance.iconPath, rel);
  });

  test('迁移遗留的绝对路径也原样保留（由 main.mjs 负责复制进 assets/）', () => {
    const abs = 'C:\\Users\\Some One\\图片\\my-icon.png';
    const { config } = normalizeConfig({ appearance: { iconPath: abs } });
    assert.equal(config.appearance.iconPath, abs);
  });
});

// ---------------------------------------------------------------------------
// 组合约束
// ---------------------------------------------------------------------------

describe('组合约束（PROTOCOL §4 注释 + 设计 §7）', () => {
  test('identityMode=custom 缺用户名/邮箱 → 报错；邮箱格式错误 → 报错；齐全 → 通过', () => {
    const missing = normalizeConfig({ stages: { commit: { identityMode: 'custom' } } });
    assert.ok(missing.errors.includes('自定义 Git 身份时用户名不能为空'));
    assert.ok(missing.errors.includes('自定义 Git 身份时邮箱不能为空'));

    const badEmail = normalizeConfig({
      stages: { commit: { identityMode: 'custom', userName: 'Bot', userEmail: 'not-an-email' } },
    });
    assert.ok(badEmail.errors.includes('Git 邮箱格式不正确'));

    const ok = normalizeConfig({
      stages: { commit: { identityMode: 'custom', userName: 'Bot', userEmail: 'bot@example.com' } },
    });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.config.stages.commit.userName, 'Bot');
  });

  test('WiFi 开启但没填 SSID → warning（不阻止保存）', () => {
    const { errors, warnings } = normalizeConfig({ wifi: { enabled: true } });
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((w) => w.includes('WiFi 管理已启用但未填写 WiFi 名称')));
  });

  test('自启动开启但没设锁定密码 → warning（仅提示）', () => {
    const { errors, warnings } = normalizeConfig({ startup: { enabled: true } });
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((w) => w.includes('未设置锁定密码')));
  });
});

// ---------------------------------------------------------------------------
// 旧版迁移（PROTOCOL §4.1）
// ---------------------------------------------------------------------------

const LEGACY_SAMPLE = {
  intervalMinutes: 25,
  runOnStart: false,
  session: 'FAKE-SESSION-VALUE',
  githubToken: 'FAKE-GH-TOKEN',
  gitToken: 'FAKE-PUSH-TOKEN',
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  syncTimeoutMinutes: 90,
  pullTimeoutMinutes: 8,
  pullBeforeSync: true,
  stepPull: true,
  pullStrategy: 'ff-only',
  stepSync: false,
  stepCommit: true,
  stepPush: false,
  retryPush: true,
  gitIdentityMode: 'custom',
  gitUserName: 'Bot',
  gitUserEmail: 'bot@example.com',
  notifyMode: 'accumulate',
  notifyEveryRuns: 5,
  logRetentionDays: 30,
  iconPath: 'C:\\icons\\foo.png',
  lockPassword: 'FAKE-LOCK-PASSWORD',
};

describe('migrateLegacyConfig（PROTOCOL §4.1 旧版扁平 → v1）', () => {
  test('isLegacyConfig 判别：有旧字段且 version≠1 才算旧版', () => {
    assert.equal(isLegacyConfig(LEGACY_SAMPLE), true);
    assert.equal(isLegacyConfig({ version: 1, intervalMinutes: 10 }), false, 'version=1 不算旧版');
    assert.equal(isLegacyConfig({ version: 1 }), false);
    assert.equal(isLegacyConfig(null), false);
    assert.equal(isLegacyConfig({ foo: 1 }), false);
  });

  test('旧版扁平字段全量映射（凭据用假值）', () => {
    const cfg = migrateLegacyConfig(LEGACY_SAMPLE);

    assert.equal(cfg.version, 1);
    // 调度 / 启动
    assert.equal(cfg.scheduler.intervalMinutes, 25);
    assert.equal(cfg.startup.runOnStart, false);
    // 运行时
    assert.equal(cfg.runtime.nodePath, 'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(cfg.runtime.syncTimeoutMinutes, 90);
    assert.equal(cfg.runtime.pullTimeoutMinutes, 8);
    // 凭据（旧字段 → credentials）
    assert.equal(cfg.credentials.H1111_SESSION, 'FAKE-SESSION-VALUE');
    assert.equal(cfg.credentials.GH_TOKEN, 'FAKE-GH-TOKEN');
    assert.equal(cfg.credentials.PUSH_TOKEN, 'FAKE-PUSH-TOKEN');
    // 阶段开关
    assert.equal(cfg.stages.pull.enabled, true, 'pullBeforeSync+stepPull 都开 → 开');
    assert.equal(cfg.stages.pull.strategy, 'ff-only');
    assert.equal(cfg.stages.sync.enabled, false);
    assert.equal(cfg.stages.commit.enabled, true);
    assert.equal(cfg.stages.push.enabled, false);
    // Git 身份：custom 保留用户名/邮箱
    assert.equal(cfg.stages.commit.identityMode, 'custom');
    assert.equal(cfg.stages.commit.userName, 'Bot');
    assert.equal(cfg.stages.commit.userEmail, 'bot@example.com');
    // 通知：accumulate → cumulative + everyRuns
    assert.equal(cfg.notifications.mode, 'cumulative');
    assert.equal(cfg.notifications.cumulative.everyRuns, 5);
    // 日志保留期
    assert.equal(cfg.logging.retentionDays, 30);
    // 图标路径原样带着（由 main.mjs 复制进 assets/）
    assert.equal(cfg.appearance.iconPath, 'C:\\icons\\foo.png');
    // 旧版 lockPassword → security.lockPassword
    assert.equal(cfg.security.lockPassword, 'FAKE-LOCK-PASSWORD');
    // retryPush 被丢弃（Push 失败恢复是强制行为，无开关）
    assert.equal(cfg.retryPush, undefined);
    assert.equal(cfg.stages.retryPush, undefined);
  });

  test('pull 阶段开关：两者都开才算开', () => {
    assert.equal(migrateLegacyConfig({ stepPull: true, pullBeforeSync: false }).stages.pull.enabled, false);
    assert.equal(migrateLegacyConfig({ stepPull: false, pullBeforeSync: true }).stages.pull.enabled, false);
    assert.equal(migrateLegacyConfig({ stepPull: true, pullBeforeSync: true }).stages.pull.enabled, true);
    // 都没写（旧版默认）→ 开
    assert.equal(migrateLegacyConfig({ intervalMinutes: 10 }).stages.pull.enabled, true);
  });

  test('pullStrategy：ff-only 保留，其它一律 rebase', () => {
    assert.equal(migrateLegacyConfig({ pullStrategy: 'ff-only' }).stages.pull.strategy, 'ff-only');
    assert.equal(migrateLegacyConfig({ pullStrategy: 'FF-Only' }).stages.pull.strategy, 'ff-only');
    assert.equal(migrateLegacyConfig({ pullStrategy: 'merge' }).stages.pull.strategy, 'rebase');
    assert.equal(migrateLegacyConfig({}).stages.pull.strategy, 'rebase');
  });

  test('gitIdentityMode：script→gha、git→default、custom→custom', () => {
    assert.equal(migrateLegacyConfig({ gitIdentityMode: 'script' }).stages.commit.identityMode, 'gha');
    assert.equal(migrateLegacyConfig({ gitIdentityMode: 'git' }).stages.commit.identityMode, 'default');
    assert.equal(migrateLegacyConfig({ gitIdentityMode: 'custom' }).stages.commit.identityMode, 'custom');
    assert.equal(migrateLegacyConfig({}).stages.commit.identityMode, 'gha', '缺省按旧版默认 script → gha');
  });

  test('notifyMode 四种旧取值映射', () => {
    const always = migrateLegacyConfig({ notifyMode: 'always' }).notifications;
    assert.equal(always.mode, 'standard');
    assert.deepEqual(always.standard, { success: true, 'up-to-date': true, failure: true, 'internal-error': true });

    const failure = migrateLegacyConfig({ notifyMode: 'failure' }).notifications;
    assert.equal(failure.mode, 'standard');
    assert.deepEqual(failure.standard, { success: false, 'up-to-date': false, failure: true, 'internal-error': true });

    const never = migrateLegacyConfig({ notifyMode: 'never' }).notifications;
    assert.equal(never.mode, 'standard');
    assert.deepEqual(never.standard, { success: false, 'up-to-date': false, failure: false, 'internal-error': false });
    assert.equal(never.cumulative.internalErrorMode, 'never');

    const accumulate = migrateLegacyConfig({ notifyMode: 'accumulate', notifyEveryRuns: 9 }).notifications;
    assert.equal(accumulate.mode, 'cumulative');
    assert.equal(accumulate.cumulative.everyRuns, 9);
    assert.equal(accumulate.cumulative.internalErrorMode, 'always');
  });

  test('间隔/超时超范围会被夹到边界值，非法值回落默认', () => {
    assert.equal(migrateLegacyConfig({ intervalMinutes: 9999 }).scheduler.intervalMinutes, 1440);
    assert.equal(migrateLegacyConfig({ intervalMinutes: 0 }).scheduler.intervalMinutes, 10);
    assert.equal(migrateLegacyConfig({ intervalMinutes: 'abc' }).scheduler.intervalMinutes, 10);
    assert.equal(migrateLegacyConfig({ syncTimeoutMinutes: 99999 }).runtime.syncTimeoutMinutes, 1440);
    assert.equal(migrateLegacyConfig({ pullTimeoutMinutes: 99999 }).runtime.pullTimeoutMinutes, 120);
    assert.equal(migrateLegacyConfig({ logRetentionDays: -5 }).logging.retentionDays, 0);
  });
});

// ---------------------------------------------------------------------------
// loadConfig：首次 / 损坏 / 旧版
// ---------------------------------------------------------------------------

describe('loadConfig（PROTOCOL §4 / §4.1 读盘行为）', () => {
  test('文件不存在 → 生成默认配置并真写盘（created=true）', () => {
    const file = freshFile();
    assert.equal(fs.existsSync(file), false);

    const res = loadConfig(file);
    assert.equal(res.created, true);
    assert.equal(res.recovered, false);
    assert.equal(res.migrated, false);
    assert.equal(res.ok, true);
    assert.deepEqual(res.errors, []);
    assert.equal(fs.existsSync(file), true, '默认配置必须真被写进文件');
    const onDisk = readJson(file);
    assert.equal(onDisk.version, 1);
    assert.deepEqual(onDisk, res.config);
    assert.equal(onDisk.scheduler.intervalMinutes, 10);
  });

  test('JSON 损坏 → 备份 *.corrupt-* 并恢复默认（recovered=true、ok=false）', () => {
    const file = freshFile();
    fs.writeFileSync(file, '{ 这不是 JSON ]', 'utf8');

    const res = loadConfig(file);
    assert.equal(res.recovered, true);
    assert.equal(res.ok, false, '损坏读入不能当成功处理');
    assert.equal(res.migrated, false);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0], /配置文件损坏/);

    // 备份存在且带时间戳
    const backups = listDir(file).filter((n) => n.startsWith('config.json.corrupt-'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^config\.json\.corrupt-\d{8}-\d{6}$/);
    assert.equal(fs.readFileSync(path.join(path.dirname(file), backups[0]), 'utf8'), '{ 这不是 JSON ]');
    assert.equal(res.backup, path.join(path.dirname(file), backups[0]));

    // 恢复成合法 JSON 默认配置
    const restored = readJson(file);
    assert.equal(restored.version, 1);
    assert.deepEqual(restored, defaultConfig());
  });

  test('旧版扁平文件 → migrated=true、有 *.legacy-* 备份、新文件 version=1', () => {
    const file = freshFile();
    fs.writeFileSync(file, JSON.stringify(LEGACY_SAMPLE, null, 2), 'utf8');

    const res = loadConfig(file);
    assert.equal(res.migrated, true);
    assert.equal(res.recovered, false);
    assert.equal(res.ok, true, `迁移不应报错，实际 errors=${JSON.stringify(res.errors)}`);
    assert.equal(res.config.version, 1);

    const backups = listDir(file).filter((n) => n.startsWith('config.json.legacy-'));
    assert.equal(backups.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(file), backups[0]), 'utf8')).session, 'FAKE-SESSION-VALUE');

    // 文件被覆盖成 v1 结构
    const onDisk = readJson(file);
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.scheduler.intervalMinutes, 25);
    assert.equal(onDisk.credentials.H1111_SESSION, 'FAKE-SESSION-VALUE');
    assert.equal(onDisk.intervalMinutes, undefined, '旧扁平字段不应残留在新文件里');
  });

  test('v1 文件缺字段 → 有 warning 并回写补齐（不等到下次保存）', () => {
    const file = freshFile();
    fs.writeFileSync(file, JSON.stringify({ version: 1 }), 'utf8');

    const res = loadConfig(file);
    assert.equal(res.ok, true);
    assert.ok(res.warnings.includes('缺少字段 scheduler.intervalMinutes，已用默认值'));
    const onDisk = readJson(file);
    assert.equal(onDisk.scheduler.intervalMinutes, 10, '缺失字段应已回写进文件');
  });

  test('v1 文件含非法值 → ok=false、有可读错误、且**不覆盖**用户文件', () => {
    const file = freshFile();
    const original = JSON.stringify({ version: 1, scheduler: { intervalMinutes: 0 } }, null, 2);
    fs.writeFileSync(file, original, 'utf8');

    const res = loadConfig(file);
    assert.equal(res.ok, false);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0], /同步间隔（分钟）（scheduler\.intervalMinutes）不能小于 1/);
    assert.equal(fs.readFileSync(file, 'utf8'), original, '校验失败时原文件一个字节都不能变');
  });

  test('读取失败（路径是目录）→ ok=false 且给出可读错误，不抛异常', () => {
    const dir = path.join(tmpRoot, 'as-dir');
    fs.mkdirSync(dir, { recursive: true });
    const res = loadConfig(dir); // 用目录冒充配置文件
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /无法读取配置文件/);
    assert.deepEqual(res.config, defaultConfig());
  });
});

// ---------------------------------------------------------------------------
// 原子保存
// ---------------------------------------------------------------------------

describe('saveConfig / writeJsonAtomic（PROTOCOL §4 原子保存）', () => {
  test('合法配置写入后是可读合法 JSON，且不留临时文件', () => {
    const file = freshFile();
    const res = saveConfig(defaultConfig(), file);
    assert.equal(res.ok, true);
    assert.equal(res.error, null);

    const onDisk = readJson(file);
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.scheduler.intervalMinutes, 10);
    // 文本以换行结尾（便于 git diff / 人工查看）
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));
    // 目录里只应有目标文件本身（临时文件已 rename 掉）
    assert.deepEqual(listDir(file), ['config.json']);
  });

  test('非法配置 → ok=false、带中文错误，且不覆盖已有文件', () => {
    const file = freshFile();
    saveConfig(defaultConfig(), file);
    const before = fs.readFileSync(file, 'utf8');

    const res = saveConfig({ scheduler: { intervalMinutes: 0 } }, file); // 只给一个非法字段
    // 注意：其余 40 个字段缺失只是 warning，唯一 error 来自 intervalMinutes
    assert.equal(res.ok, false);
    assert.match(res.error, /同步间隔（分钟）（scheduler\.intervalMinutes）不能小于 1/);
    assert.equal(res.errors.length, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), before, '校验失败绝不能覆盖原文件');
    assert.deepEqual(listDir(file), ['config.json'], '失败的写入不能残留临时文件');
  });

  test('writeJsonAtomic 目标目录不存在时自动创建', () => {
    const nested = path.join(tmpRoot, 'deep', 'a', 'b', 'config.json');
    const res = writeJsonAtomic(nested, { hello: '世界' });
    assert.equal(res.ok, true);
    assert.deepEqual(readJson(nested), { hello: '世界' });
  });

  test('writeJsonAtomic 失败（父路径是文件）→ ok=false 且错误可读，不抛异常', () => {
    const blocker = path.join(tmpRoot, 'blocker');
    fs.writeFileSync(blocker, 'x', 'utf8');
    const res = writeJsonAtomic(path.join(blocker, 'config.json'), { a: 1 });
    assert.equal(res.ok, false);
    assert.equal(typeof res.error, 'string');
    assert.ok(res.error.length > 0);
  });

  test('saveConfig 返回的 config 是归一化后的结果（宿主可直接采用）', () => {
    const file = freshFile();
    const res = saveConfig({ scheduler: { intervalMinutes: '33' }, credentials: { PUSH_TOKEN: 'FAKE-PUSH' } }, file);
    assert.equal(res.ok, true);
    assert.equal(res.config.scheduler.intervalMinutes, 33);
    assert.equal(res.config.credentials.PUSH_TOKEN, 'FAKE-PUSH');
    assert.equal(res.config.version, 1);
  });
});

// ---------------------------------------------------------------------------
// secretsOf：脱敏集合来源
// ---------------------------------------------------------------------------

describe('secretsOf（PROTOCOL §9 脱敏集合）', () => {
  test('收集非空凭据 + WiFi 密码 + 锁定密码，忽略空值', () => {
    const cfg = defaultConfig();
    cfg.credentials.H1111_SESSION = 'FAKE-SESSION-VALUE';
    cfg.credentials.GH_TOKEN = 'FAKE-GH-TOKEN';
    cfg.wifi.password = 'FAKE-WIFI-PASS';
    cfg.security.lockPassword = 'FAKE-LOCK-PASS';
    const list = secretsOf(cfg);
    assert.deepEqual(list.sort(), [
      'FAKE-GH-TOKEN', 'FAKE-LOCK-PASS', 'FAKE-SESSION-VALUE', 'FAKE-WIFI-PASS',
    ]);
    assert.equal(secretsOf({}).length, 0);
    assert.equal(secretsOf(null).length, 0);
  });
});
