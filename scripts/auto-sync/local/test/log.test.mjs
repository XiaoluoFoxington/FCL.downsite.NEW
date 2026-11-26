// log.test.mjs — 日志：脱敏、行格式、保留期清理
//
// 对应 PROTOCOL.md §9 与设计文档 §20.1「凭据不出现在日志」：
//   · redact：注册的凭据值 + 常见 token/cookie 形态 → ***；过短的注册值不参与替换（避免误伤）
//   · createLogger 行格式：[YYYY-MM-DD HH:MM:SS.mmm] [LEVEL] [Tag] 消息
//   · cleanupOldLogs 只删超过保留期的 YYYY/MM/DD 目录；retentionDays=0 不动任何东西
//
// 【日志根目录注入方式】
//   log.mjs 自身不提供注入参数，它从 paths.mjs 导入 LOG_DIR，而 paths.mjs 支持
//   `process.env.FDN_LOCAL_DIR` 重定向「本机运行数据」目录（该环境变量只用于测试/联调）。
//   因此本文件先设 FDN_LOCAL_DIR 指向临时目录，再**动态 import** log.mjs，
//   这样 LOG_DIR = <临时目录>/logs，测试不会碰真实 local/logs，也不用 monkey-patch 产品代码。
//   （本文件是独立测试进程，env 改动不影响其它测试文件。）

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fdn-log-'));
process.env.FDN_LOCAL_DIR = tmpRoot; // 必须在 import log.mjs 之前设置（LOG_DIR 在模块加载时求值）

const logMod = await import('../modules/log.mjs');
const pathsMod = await import('../modules/paths.mjs');
const { LOG_DIR } = pathsMod;
const {
  stamp, dayDir, runLogPath, registerSecrets, redact, createLogger, cleanupOldLogs, rawLine,
} = logMod;

const LOG_ROOT = path.join(tmpRoot, 'logs');

/** 造一个「某年某月某日」的本地 Date，便于断言目录名 */
const localDate = (y, m, d, hh = 12, mm = 0, ss = 0, ms = 0) => new Date(y, m - 1, d, hh, mm, ss, ms);

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l !== '');
}

function mkDayDir(y, m, d, fileName = 'run.log', content = 'x\n') {
  const dir = path.join(LOG_ROOT, String(y), String(m).padStart(2, '0'), String(d).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content, 'utf8');
  return dir;
}

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 注入点自检
// ---------------------------------------------------------------------------

describe('日志根目录注入（FDN_LOCAL_DIR，PROTOCOL §2 目录约定）', () => {
  test('LOG_DIR 被重定向到临时目录，真实 local/logs 未被使用', () => {
    assert.equal(path.resolve(LOG_DIR), path.resolve(LOG_ROOT));
    assert.equal(path.resolve(LOG_DIR).startsWith(path.resolve(tmpRoot)), true);
  });

  test('dayDir / runLogPath 按 YYYY/MM/DD 分目录', () => {
    const d = localDate(2026, 11, 26);
    assert.equal(dayDir(d), path.join(LOG_ROOT, '2026', '11', '26'));
    assert.equal(runLogPath(d), path.join(LOG_ROOT, '2026', '11', '26', 'run.log'));
    // 月/日补零
    const d2 = localDate(2026, 1, 5);
    assert.equal(dayDir(d2), path.join(LOG_ROOT, '2026', '01', '05'));
  });

  test('stamp 格式为 YYYY-MM-DD HH:MM:SS.mmm（本地时区、毫秒补 3 位）', () => {
    assert.equal(stamp(localDate(2026, 11, 26, 20, 0, 0, 123)), '2026-11-26 20:00:00.123');
    assert.equal(stamp(localDate(2026, 1, 2, 3, 4, 5, 7)), '2026-01-02 03:04:05.007');
    assert.match(stamp(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

describe('redact（PROTOCOL §9：写入前统一脱敏）', () => {
  test('注册过的凭据值被替换成 ***', () => {
    registerSecrets(['FAKE-SESSION-VALUE-123', 'FAKE-PUSH-TOKEN-XYZ']);
    assert.equal(redact('session=FAKE-SESSION-VALUE-123 ok'), 'session=*** ok');
    assert.equal(redact('两个 FAKE-PUSH-TOKEN-XYZ 与 FAKE-SESSION-VALUE-123'), '两个 *** 与 ***');
    // 原文不得残留
    assert.ok(!redact('a FAKE-SESSION-VALUE-123 b').includes('FAKE-SESSION-VALUE-123'));
  });

  test('过短的注册值（<6 字符）不参与替换，避免误伤普通日志', () => {
    registerSecrets(['123', 'abcde']); // 3 字符 / 5 字符
    assert.equal(redact('共有 123 个资源，abcde 只是普通单词'), '共有 123 个资源，abcde 只是普通单词');
  });

  test('常见凭据形态：ghp_ / github_pat_ / Bearer / cloudreve-session / Basic 头', () => {
    const ghp = `ghp_${'A'.repeat(36)}`;
    assert.equal(redact(`token is ${ghp} end`), 'token is *** end');

    const pat = `github_pat_${'B'.repeat(30)}`;
    assert.equal(redact(`use ${pat}`), 'use ***');

    assert.equal(redact('Authorization: Bearer abc.def-123_456'), 'Authorization: ***');

    assert.equal(redact('Cookie: cloudreve-session=abc123XYZ; other=1'), 'Cookie: ***; other=1');

    assert.equal(
      redact('authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=='),
      '***',
    );
  });

  test('null / undefined / 数字输入不抛异常', () => {
    assert.equal(redact(null), '');
    assert.equal(redact(undefined), '');
    assert.equal(redact(12345), '12345');
    assert.equal(redact(''), '');
  });

  test('普通中文日志不被误改', () => {
    const text = '开始同步（触发：timer）｜本轮结束：success';
    assert.equal(redact(text), text);
  });

  test('注册值与正则混合出现时全部被抹掉', () => {
    registerSecrets(['FAKE-MIXED-VALUE-1']);
    const ghp = `ghp_${'C'.repeat(40)}`;
    const out = redact(`a=FAKE-MIXED-VALUE-1 b=${ghp} c=Bearer xyz.123`);
    assert.equal(out, 'a=*** b=*** c=***');
  });
});

// ---------------------------------------------------------------------------
// 行格式
// ---------------------------------------------------------------------------

describe('createLogger（PROTOCOL §9 行格式）', () => {
  test('INFO 行格式：`[YYYY-MM-DD HH:MM:SS.mmm] [INFO] [Tag] 消息`', () => {
    const fixed = localDate(2026, 11, 26, 20, 0, 0, 123);
    const logger = createLogger({ now: () => fixed });

    assert.equal(logger.info('Scheduler', '开始同步'), true);

    const file = logger.path();
    assert.equal(file, path.join(LOG_ROOT, '2026', '11', '26', 'run.log'));
    assert.equal(fs.existsSync(file), true);
    assert.deepEqual(readLines(file), ['[2026-11-26 20:00:00.123] [INFO] [Scheduler] 开始同步']);
  });

  test('四个等级与默认 Tag（App），DEBUG 在 INFO 级别下不写', () => {
    const fixed = localDate(2026, 11, 27, 1, 2, 3, 4);
    const logger = createLogger({ now: () => fixed });

    assert.equal(logger.debug('Scheduler', '被过滤'), false);
    assert.equal(logger.info('', '无 tag'), true);
    assert.equal(logger.warn('Icon', '图标合成失败'), true);
    assert.equal(logger.error('Main', '状态保存失败'), true);

    const lines = readLines(logger.path());
    assert.deepEqual(lines, [
      '[2026-11-27 01:02:03.004] [INFO] [App] 无 tag',
      '[2026-11-27 01:02:03.004] [WARN] [Icon] 图标合成失败',
      '[2026-11-27 01:02:03.004] [ERROR] [Main] 状态保存失败',
    ]);
  });

  test('level=WARN 时 INFO 与 DEBUG 都不写；level=DEBUG 时都写', () => {
    const d1 = localDate(2026, 11, 28);
    const warnOnly = createLogger({ level: 'WARN', now: () => d1 });
    assert.equal(warnOnly.debug('T', 'd'), false);
    assert.equal(warnOnly.info('T', 'i'), false);
    assert.equal(warnOnly.warn('T', 'w'), true);
    assert.deepEqual(readLines(warnOnly.path()), ['[2026-11-28 12:00:00.000] [WARN] [T] w']);

    const d2 = localDate(2026, 11, 29);
    const verbose = createLogger({ level: 'DEBUG', now: () => d2 });
    assert.equal(verbose.debug('T', 'd'), true);
    verbose.info('T', 'i');
    assert.deepEqual(readLines(verbose.path()), [
      '[2026-11-29 12:00:00.000] [DEBUG] [T] d',
      '[2026-11-29 12:00:00.000] [INFO] [T] i',
    ]);
  });

  test('落盘内容已脱敏（凭据值不出现在日志文件里）', () => {
    registerSecrets(['FAKE-LOG-SECRET-777']);
    const fixed = localDate(2026, 11, 30);
    const logger = createLogger({ now: () => fixed });
    logger.info('Config', '已加载凭据 FAKE-LOG-SECRET-777');

    const text = fs.readFileSync(logger.path(), 'utf8');
    assert.ok(!text.includes('FAKE-LOG-SECRET-777'), '日志文件不得含凭据原文');
    assert.ok(text.includes('[INFO] [Config] 已加载凭据 ***'));
  });

  test('child() 加 [sync] 前缀、raw() 原样写（子进程输出落 run.log）', () => {
    const fixed = localDate(2026, 12, 1);
    const logger = createLogger({ now: () => fixed });
    logger.child('同步了 2 个资源');
    logger.raw('===== 分隔线 =====');
    assert.deepEqual(readLines(logger.path()), ['[sync] 同步了 2 个资源', '===== 分隔线 =====']);
  });

  test('append：多次写入追加到同一当日文件', () => {
    const fixed = localDate(2026, 12, 2);
    const a = createLogger({ now: () => fixed });
    a.info('Main', '第一条');
    const b = createLogger({ now: () => fixed });
    b.info('Main', '第二条');
    assert.deepEqual(readLines(runLogPath(fixed)), [
      '[2026-12-02 12:00:00.000] [INFO] [Main] 第一条',
      '[2026-12-02 12:00:00.000] [INFO] [Main] 第二条',
    ]);
  });

  test('rawLine() 兼容旧调用：直接写当日 run.log（无时间戳、无 tag）', () => {
    const fixed = localDate(2026, 12, 3);
    assert.equal(rawLine('旧接口一行', fixed), true);
    assert.deepEqual(readLines(runLogPath(fixed)), ['旧接口一行']);
  });

  test('跨日期写入落到对应日期目录（按本地时区）', () => {
    let current = localDate(2026, 12, 4, 23, 59, 59, 999);
    const logger = createLogger({ now: () => current });
    logger.info('Main', '今天最后一行');
    current = localDate(2026, 12, 5, 0, 0, 0, 1);
    logger.info('Main', '明天第一行');

    assert.deepEqual(readLines(runLogPath(localDate(2026, 12, 4))), ['[2026-12-04 23:59:59.999] [INFO] [Main] 今天最后一行']);
    assert.deepEqual(readLines(runLogPath(localDate(2026, 12, 5))), ['[2026-12-05 00:00:00.001] [INFO] [Main] 明天第一行']);
  });
});

// ---------------------------------------------------------------------------
// 保留期清理
// ---------------------------------------------------------------------------

describe('cleanupOldLogs（PROTOCOL §9：只清本程序日志、0=永久）', () => {
  // 注意：本 describe 会删掉上面用例写下的日志目录（放在最后执行），
  // 每个用例都先用 resetRoot() 回到干净状态，避免用例之间互相依赖残留文件。
  const NOW = localDate(2026, 11, 26, 12, 0, 0);
  const resetRoot = () => fs.rmSync(LOG_ROOT, { recursive: true, force: true });

  test('日志根目录不存在 → 不抛异常，removed=0', () => {
    resetRoot();
    const r = cleanupOldLogs(7, NOW);
    assert.deepEqual(r, { removed: 0, skipped: false });
  });

  test('只删超出保留期的 YYYY/MM/DD 目录，保留窗口内的目录', () => {
    resetRoot();
    const oldA = mkDayDir(2020, 1, 1);
    const oldB = mkDayDir(2020, 1, 2);
    const oldC = mkDayDir(2020, 2, 5);
    const inWindow = mkDayDir(2026, 11, 20);
    const today = mkDayDir(2026, 11, 26);
    // 非日期目录必须不动
    const odd = path.join(LOG_ROOT, 'backups', '2020', '01', '01');
    fs.mkdirSync(odd, { recursive: true });
    fs.writeFileSync(path.join(odd, 'run.log'), '保留我\n', 'utf8');

    const r = cleanupOldLogs(7, NOW); // 截止 2026-11-19

    assert.equal(r.skipped, false);
    assert.equal(r.removed, 3);
    assert.equal(fs.existsSync(oldA), false);
    assert.equal(fs.existsSync(oldB), false);
    assert.equal(fs.existsSync(oldC), false);
    assert.equal(fs.existsSync(inWindow), true, '窗口内的 2026/11/20 必须保留');
    assert.equal(fs.existsSync(today), true, '当天目录必须保留');
    assert.equal(fs.existsSync(path.join(odd, 'run.log')), true, '非 YYYY/MM/DD 目录不得被清理');
    // 清空后的月目录顺手删掉，但年级目录本身不删
    assert.equal(fs.existsSync(path.join(LOG_ROOT, '2020', '01')), false);
    assert.equal(fs.existsSync(path.join(LOG_ROOT, '2020', '02')), false);
    assert.equal(fs.existsSync(path.join(LOG_ROOT, '2020')), true);
  });

  test('边界：目录名正好等于截止日 → 保留（key >= cutoffKey）', () => {
    resetRoot();
    const keep = mkDayDir(2026, 11, 19);
    const drop = mkDayDir(2026, 11, 18);
    const r = cleanupOldLogs(7, NOW);
    assert.equal(fs.existsSync(keep), true, '正好 7 天前当天保留');
    assert.equal(fs.existsSync(drop), false, '7 天前一天删除');
    assert.equal(r.removed, 1);
  });

  test('retentionDays=0 → 什么都不动（永久保留）', () => {
    resetRoot();
    const keepA = mkDayDir(2019, 5, 5);
    const keepB = mkDayDir(2026, 11, 20);
    const r = cleanupOldLogs(0, NOW);
    assert.deepEqual(r, { removed: 0, skipped: true });
    assert.equal(fs.existsSync(keepA), true);
    assert.equal(fs.existsSync(keepB), true);
  });

  test('retentionDays 非法（负数 / 非数字）→ 视为永久保留', () => {
    resetRoot();
    const keep = mkDayDir(2018, 3, 3);
    assert.deepEqual(cleanupOldLogs(-1, NOW), { removed: 0, skipped: true });
    assert.deepEqual(cleanupOldLogs('abc', NOW), { removed: 0, skipped: true });
    assert.deepEqual(cleanupOldLogs(undefined, NOW), { removed: 0, skipped: true });
    assert.deepEqual(cleanupOldLogs(null, NOW), { removed: 0, skipped: true });
    assert.equal(fs.existsSync(keep), true);
  });

  test('字符串数字（配置里可能是字符串）也能正常工作', () => {
    resetRoot();
    const keep = mkDayDir(2026, 11, 22);
    const drop = mkDayDir(2017, 7, 7);
    const r = cleanupOldLogs('30', NOW); // 截止 2026-10-27
    assert.equal(r.removed, 1);
    assert.equal(fs.existsSync(keep), true);
    assert.equal(fs.existsSync(drop), false);
  });
});
