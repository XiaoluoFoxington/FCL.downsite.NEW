// notification.test.mjs — 标准 / 累积通知文案与发送决策
//
// 对应设计文档 §20.2 / §11 与 PROTOCOL.md §3.1（notify）：
//   · 标准模式按结果类型 + 勾选项决定是否通知；四种状态的标题/正文关键词可辨识
//   · 累积模式：未到 everyRuns 不发；到点发汇总并清零（reset=true）
//   · internal-error 在 cumulative + internalErrorMode='always' 时立即单独发且不清零（reset=false）
//   · 'never' 时不单独发（只能等汇总）
//   · **文案绝不含任何凭据**（Token / Cookie / 密码）

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultConfig, secretsOf } from '../modules/config.mjs';
import { defaultState, recordResult } from '../modules/state.mjs';
import {
  buildStandard, buildCumulative, decideNotification, hhmm,
} from '../modules/notification.mjs';

const NEXT_RUN_AT = '2026-11-26T12:10:18.000Z';

function cfgWith(mutate) {
  const cfg = defaultConfig();
  mutate(cfg);
  return cfg;
}

/** 造一个「本轮已 recordResult 过」的状态（累积计数已 +1） */
function stateAfter(runs, over = {}) {
  let s = defaultState();
  for (const r of runs) s = recordResult(s, r);
  Object.assign(s, over);
  return s;
}

const successResult = (over = {}) => ({
  status: 'success',
  startedAt: '2026-11-26T12:00:00.000Z',
  finishedAt: '2026-11-26T12:00:18.000Z',
  durationMs: 18000,
  message: '同步了 2 个资源，共 3 个版本',
  stats: { resources: 2, versions: 3 },
  error: null,
  ...over,
});

function su(text, re) {
  assert.match(String(text), re);
}

// ---------------------------------------------------------------------------
// 标准模式：四种状态的文案
// ---------------------------------------------------------------------------

describe('标准模式文案（PROTOCOL §3.1 notify / 设计 §11）', () => {
  test('success：标题「自动同步成功」，正文含「个资源」与下次时间', () => {
    const d = decideNotification({
      result: successResult(),
      config: defaultConfig(),
      state: stateAfter([successResult()]),
      nextRunAt: NEXT_RUN_AT,
    });
    assert.equal(d.send, true);
    assert.equal(d.mode, 'standard');
    assert.equal(d.title, '自动同步成功');
    su(d.text, /同步了 2 个资源，共 3 个版本。/);
    su(d.text, /下次同步时间：\d{2}:\d{2}/);
    assert.equal(d.reset, true, '标准模式发完即清零（防以后切累积模式带旧账）');
  });

  test('success 无 stats 时退回 message（不为空、不虚构资源数）', () => {
    const d = decideNotification({
      result: successResult({ stats: null, message: '提交保留在本地（Push 已关闭）' }),
      config: defaultConfig(),
      state: stateAfter([successResult()]),
    });
    assert.equal(d.send, true);
    assert.equal(d.text, '提交保留在本地（Push 已关闭）。', '没有下次时间时不留多余标点');
    assert.ok(!d.text.includes('个资源'));
  });

  test('up-to-date：标题「自动同步完成」，正文含「当前已是最新」+ 下次时间', () => {
    const cfg = cfgWith((c) => { c.notifications.standard['up-to-date'] = true; });
    const result = successResult({ status: 'up-to-date', stats: null, message: '当前已是最新' });
    const d = decideNotification({ result, config: cfg, state: stateAfter([result]), nextRunAt: NEXT_RUN_AT });

    assert.equal(d.send, true);
    assert.equal(d.title, '自动同步完成');
    su(d.text, /当前已是最新/);
    su(d.text, /下次同步时间：\d{2}:\d{2}/);
  });

  test('failure：标题「自动同步失败」，正文含「阶段失败」与阶段中文名', () => {
    const result = successResult({
      status: 'failure',
      stats: null,
      message: '远端拒绝了推送',
      error: { stage: 'push', code: 'GIT_PUSH_REJECTED', message: '远端拒绝了推送（远端有新提交，需要先拉取）' },
    });
    const d = decideNotification({ result, config: defaultConfig(), state: stateAfter([result]) });

    assert.equal(d.send, true);
    assert.equal(d.title, '自动同步失败');
    su(d.text, /推送阶段失败：/);
    su(d.text, /阶段失败/);
    su(d.text, /远端拒绝了推送/);
  });

  test('failure 未知阶段 → 用「未知」而不是 undefined', () => {
    const result = successResult({
      status: 'failure', stats: null, message: 'x', error: { stage: 'weird', code: 'C', message: '出错' },
    });
    const d = decideNotification({ result, config: defaultConfig(), state: stateAfter([result]) });
    assert.equal(d.text, '未知阶段失败：出错');
  });

  test('internal-error：标题含「内部错误」，正文提示查看日志', () => {
    const result = successResult({
      status: 'internal-error', stats: null, message: '状态文件无法保存',
      error: { stage: 'state', code: 'STATE_SAVE_FAILED', message: '状态文件无法保存' },
    });
    const d = decideNotification({ result, config: defaultConfig(), state: stateAfter([result]) });

    assert.equal(d.send, true);
    su(d.title, /内部错误/);
    assert.equal(d.title, '自动同步内部错误');
    su(d.text, /状态文件无法保存/);
    su(d.text, /请查看日志/);
  });

  test('internal-error 无 error.message → 兜底文案「程序内部错误」', () => {
    const result = successResult({ status: 'internal-error', stats: null, message: '', error: null });
    const d = decideNotification({ result, config: defaultConfig(), state: stateAfter([result]) });
    assert.equal(d.text, '程序内部错误。请查看日志。');
  });

  test('长 message 被压成单行并截断（Toast 不能爆掉）', () => {
    const long = `${'很长的错误\n细节  '.repeat(40)}`;
    const { text } = buildStandard(successResult({ status: 'failure', stats: null, error: { stage: 'sync', message: long } }));
    assert.ok(!text.includes('\n'), '必须压成单行');
    assert.ok(text.length <= 200, `正文应被截断，实际 ${text.length} 字符`);
  });
});

// ---------------------------------------------------------------------------
// 标准模式勾选项
// ---------------------------------------------------------------------------

describe('标准模式勾选项决定 send（PROTOCOL §4 notifications.standard）', () => {
  test('某状态被勾掉 → send=false 且不带任何文案', () => {
    const cfg = cfgWith((c) => { c.notifications.standard.failure = false; });
    const result = successResult({ status: 'failure', stats: null, error: { stage: 'push', message: 'x' } });
    const d = decideNotification({ result, config: cfg, state: stateAfter([result]) });

    assert.equal(d.send, false);
    assert.equal(d.mode, 'none');
    assert.equal(d.title, '');
    assert.equal(d.text, '');
    assert.equal(d.reset, true, '标准模式即使不发也清零累积计数');
  });

  test('默认配置下 up-to-date 不通知（ogg 默认关），success/failure/internal-error 通知', () => {
    const cfg = defaultConfig();
    const expectations = {
      success: true,
      'up-to-date': false,
      failure: true,
      'internal-error': true,
    };
    for (const [status, wantSend] of Object.entries(expectations)) {
      const result = successResult({
        status,
        stats: status === 'success' ? { resources: 1, versions: 1 } : null,
        error: status === 'failure' || status === 'internal-error' ? { stage: 'sync', code: 'X', message: 'm' } : null,
      });
      const d = decideNotification({ result, config: cfg, state: stateAfter([result]) });
      assert.equal(d.send, wantSend, `${status} 默认应 ${wantSend ? '通知' : '不通知'}`);
    }
  });

  test('四项全关 → 任何状态都不发', () => {
    const cfg = cfgWith((c) => {
      c.notifications.standard = { success: false, 'up-to-date': false, failure: false, 'internal-error': false };
    });
    for (const status of ['success', 'up-to-date', 'failure', 'internal-error']) {
      const result = successResult({ status, stats: null, error: { stage: 'sync', message: 'm' } });
      assert.equal(decideNotification({ result, config: cfg, state: stateAfter([result]) }).send, false);
    }
  });

  test('mode 缺失/非法时按 standard 处理（不崩）', () => {
    const cfg = defaultConfig();
    cfg.notifications.mode = 'bogus';
    const d = decideNotification({ result: successResult(), config: cfg, state: stateAfter([successResult()]) });
    assert.equal(d.send, true);
    assert.equal(d.mode, 'standard');
  });
});

// ---------------------------------------------------------------------------
// 累积模式
// ---------------------------------------------------------------------------

describe('累积模式（PROTOCOL §4 notifications.cumulative）', () => {
  test('pendingRuns 未到 everyRuns → 不发', () => {
    const cfg = cfgWith((c) => {
      c.notifications.mode = 'cumulative';
      c.notifications.cumulative.everyRuns = 3;
    });
    // 已经跑了 2 轮（pendingRuns = 2）
    const state = stateAfter([successResult(), successResult({ status: 'up-to-date', stats: null })]);
    assert.equal(state.notification.pendingRuns, 2);

    const d = decideNotification({ result: successResult(), config: cfg, state });
    assert.equal(d.send, false);
    assert.equal(d.mode, 'none');
    assert.equal(d.reset, false, '不发就不清零');
  });

  test('pendingRuns 到 everyRuns → 发汇总并 reset=true', () => {
    const cfg = cfgWith((c) => {
      c.notifications.mode = 'cumulative';
      c.notifications.cumulative.everyRuns = 3;
    });
    const state = stateAfter([
      successResult(),
      successResult({ status: 'up-to-date', stats: null }),
      successResult({ status: 'failure', stats: null }),
    ]);
    assert.equal(state.notification.pendingRuns, 3);

    const d = decideNotification({ result: successResult(), config: cfg, state });
    assert.equal(d.send, true);
    assert.equal(d.mode, 'cumulative');
    assert.equal(d.reset, true, '汇总发出后必须清零累积计数');
    assert.equal(d.title, '自动同步运行汇总');
    su(d.text, /共运行 3 次/);
    su(d.text, /成功：1 次/);
    su(d.text, /已是最新：1 次/);
    su(d.text, /失败：1 次/);
    su(d.text, /内部错误：0 次/);
  });

  test('buildCumulative 直接排版（多行汇总，含四类计数）', () => {
    const state = stateAfter([
      successResult(),
      successResult({ status: 'internal-error', stats: null }),
    ]);
    const { title, text } = buildCumulative(state, 7);
    assert.equal(title, '自动同步运行汇总');
    assert.deepEqual(text.split('\n'), [
      '自上次通知后共运行 2 次：',
      '成功：1 次',
      '已是最新：0 次',
      '失败：0 次',
      '内部错误：1 次',
    ]);
  });

  test('internal-error + internalErrorMode=always → 立即单独发且 reset=false（计数不清零）', () => {
    const cfg = cfgWith((c) => {
      c.notifications.mode = 'cumulative';
      c.notifications.cumulative.everyRuns = 7;
      c.notifications.cumulative.internalErrorMode = 'always';
    });
    const result = successResult({
      status: 'internal-error', stats: null, message: '未捕获异常',
      error: { stage: 'unknown', code: 'UNEXPECTED_ERROR', message: '未捕获异常' },
    });
    const state = stateAfter([result]);
    assert.equal(state.notification.pendingRuns, 1, '远未到 everyRuns');

    const d = decideNotification({ result, config: cfg, state, nextRunAt: NEXT_RUN_AT });
    assert.equal(d.send, true);
    assert.equal(d.mode, 'cumulative');
    assert.equal(d.reset, false, '单独发的内部错误不清零累积计数');
    assert.equal(d.title, '自动同步内部错误');
    su(d.text, /未捕获异常/);
  });

  test('internal-error + internalErrorMode=never → 不单独发', () => {
    const cfg = cfgWith((c) => {
      c.notifications.mode = 'cumulative';
      c.notifications.cumulative.everyRuns = 7;
      c.notifications.cumulative.internalErrorMode = 'never';
    });
    const result = successResult({ status: 'internal-error', stats: null, error: { stage: 'x', message: 'y' } });
    const state = stateAfter([result]);

    const d = decideNotification({ result, config: cfg, state });
    assert.equal(d.send, false);
    assert.equal(d.mode, 'none');
    assert.equal(d.reset, false);
  });

  test('never 模式下到点仍会随汇总一起发（只是不单独发）', () => {
    const cfg = cfgWith((c) => {
      c.notifications.mode = 'cumulative';
      c.notifications.cumulative.everyRuns = 2;
      c.notifications.cumulative.internalErrorMode = 'never';
    });
    const result = successResult({ status: 'internal-error', stats: null, error: { stage: 'x', message: 'y' } });
    const state = stateAfter([result, successResult({ status: 'failure', stats: null })]);

    const d = decideNotification({ result, config: cfg, state });
    assert.equal(d.send, true);
    assert.equal(d.title, '自动同步运行汇总');
    assert.equal(d.reset, true);
    su(d.text, /内部错误：1 次/);
  });

  test('everyRuns 缺省/非法时按 7 处理', () => {
    const cfg = cfgWith((c) => {
      c.notifications.mode = 'cumulative';
      c.notifications.cumulative.everyRuns = 0; // 非法，回落 7
    });
    const want = 7;
    const six = stateAfter(Array.from({ length: want - 1 }, () => successResult()));
    assert.equal(decideNotification({ result: successResult(), config: cfg, state: six }).send, false);

    const seven = stateAfter(Array.from({ length: want }, () => successResult()));
    assert.equal(decideNotification({ result: successResult(), config: cfg, state: seven }).send, true);
  });
});

// ---------------------------------------------------------------------------
// 文案安全：不含凭据
// ---------------------------------------------------------------------------

describe('文案安全（PROTOCOL §3.1「状态/通知绝不包含凭据」）', () => {
  const FAKE_VALUES = {
    H1111_SESSION: 'FAKE-SESSION-VALUE-9f3a',
    H1111_USER: 'FAKE-USER-VALUE-11',
    H1111_PASSWORD: 'FAKE-H1111-PASSWORD-7c',
    GH_TOKEN: 'FAKE-TOKEN-abc123456789',
    PUSH_TOKEN: 'FAKE-PUSH-TOKEN-xyz987',
    wifiPassword: 'FAKE-WIFI-PASSWORD-42',
    lockPassword: 'FAKE-LOCK-PASSWORD-88',
  };

  function credentialConfig() {
    const cfg = defaultConfig();
    cfg.credentials.H1111_SESSION = FAKE_VALUES.H1111_SESSION;
    cfg.credentials.H1111_USER = FAKE_VALUES.H1111_USER;
    cfg.credentials.H1111_PASSWORD = FAKE_VALUES.H1111_PASSWORD;
    cfg.credentials.GH_TOKEN = FAKE_VALUES.GH_TOKEN;
    cfg.credentials.PUSH_TOKEN = FAKE_VALUES.PUSH_TOKEN;
    cfg.wifi.password = FAKE_VALUES.wifiPassword;
    cfg.security.lockPassword = FAKE_VALUES.lockPassword;
    return cfg;
  }

  test('四种状态 × 两种模式的输出都不含任何配置里的凭据值', () => {
    const cfg = credentialConfig();
    const secrets = secretsOf(cfg);
    assert.equal(secrets.length, 7, '前提：配置里确实有 7 个凭据值');

    const statuses = ['success', 'up-to-date', 'failure', 'internal-error'];
    const outputs = [];

    // 标准模式（四项全开以便覆盖所有文案分支）
    const standardCfg = credentialConfig();
    standardCfg.notifications.standard = { success: true, 'up-to-date': true, failure: true, 'internal-error': true };
    for (const status of statuses) {
      const result = successResult({
        status,
        stats: status === 'success' ? { resources: 2, versions: 3 } : null,
        message: `阶段消息（${status}）`,
        error: status === 'failure' || status === 'internal-error'
          ? { stage: 'push', code: 'C', message: `错误消息（${status}）` }
          : null,
      });
      outputs.push(decideNotification({ result, config: standardCfg, state: stateAfter([result]), nextRunAt: NEXT_RUN_AT }));
    }

    // 累积模式（到点汇总 + 内部错误单独发）
    const cumulativeCfg = credentialConfig();
    cumulativeCfg.notifications.mode = 'cumulative';
    cumulativeCfg.notifications.cumulative.everyRuns = 1;
    for (const status of statuses) {
      const result = successResult({
        status,
        stats: null,
        message: `阶段消息（${status}）`,
        error: { stage: 'push', code: 'C', message: `错误消息（${status}）` },
      });
      outputs.push(decideNotification({ result, config: cumulativeCfg, state: stateAfter([result]), nextRunAt: NEXT_RUN_AT }));
    }

    for (const out of outputs) {
      const blob = `${out.title}\n${out.text}`;
      for (const secret of secrets) {
        assert.ok(!blob.includes(secret), `通知文案泄露了凭据「${secret}」：${blob}`);
      }
      assert.ok(!/FAKE-/.test(blob), `通知文案不应出现 FAKE- 前缀的假凭据：${blob}`);
    }
    // 顺带确认凭据确实存在于配置中（避免测试本身没意义）
    assert.ok(JSON.stringify(cfg.credentials).includes('FAKE-TOKEN'));
  });
});

// ---------------------------------------------------------------------------
// 边缘
// ---------------------------------------------------------------------------

describe('边缘情况', () => {
  test('hhmm：非法/缺失时间返回空串（不出现 NaN:NaN）', () => {
    assert.equal(hhmm(null), '');
    assert.equal(hhmm(''), '');
    assert.equal(hhmm('not-a-date'), '');
    assert.match(hhmm('2026-11-26T12:10:18.000Z'), /^\d{2}:\d{2}$/);
  });

  test('nextRunAt 缺失时文案里不出现「下次同步时间」（不虚构时间）', () => {
    const d = decideNotification({
      result: successResult(), config: defaultConfig(), state: stateAfter([successResult()]),
    });
    assert.ok(!d.text.includes('下次同步时间'));
  });

  test('decideNotification 对残缺输入不抛异常', () => {
    assert.doesNotThrow(() => decideNotification({ result: {}, config: {}, state: {} }));
    const d = decideNotification({ result: { status: 'success' }, config: {}, state: {} });
    assert.equal(d.send, false, '默认 config {} 没有勾选项，按不通知处理');
  });
});
