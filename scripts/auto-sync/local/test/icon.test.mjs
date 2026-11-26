// icon.test.mjs — 托盘图标：角标决策、缓存键、ICO 打包、PNG 尺寸解析
//
// 对应设计文档 §6 / §20.6 与 PROTOCOL.md §8：
//   · 角标优先级：同步中 > 暂停 > 最近结果 > 无（锁定不改变角标）
//   · 缓存键 = sha256(底图字节) : badge : sizes，同参数必须稳定
//   · ICO 结构：6 字节头（reserved/type/count）+ n×16 字节目录 + 图像数据，
//     dwImageOffset 连续、总长 = 6 + 16n + Σdata
//   · pngSize 从 IHDR 读出宽高；非 PNG 返回 null
// 这里不调用 GDI+（icon-compose.ps1），只测纯函数。

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  ICON_SIZES, decideBadge, cacheKey, buildIco, pngSize,
} from '../modules/tray-icon.mjs';

/** 生成一段**真实**（可被任意 PNG 解码器读出的）PNG：RGBA、全透明 */
function makePng(width, height) {
  const rowLen = width * 4 + 1; // 每行开头 1 字节 filter=0
  const raw = Buffer.alloc(rowLen * height);
  const idat = zlib.deflateSync(raw);

  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);   // width
  ihdr.writeUInt32BE(height, 4);  // height
  ihdr.writeUInt8(8, 8);          // bit depth
  ihdr.writeUInt8(6, 9);          // color type = RGBA
  ihdr.writeUInt8(0, 10);         // compression
  ihdr.writeUInt8(0, 11);         // filter
  ihdr.writeUInt8(0, 12);         // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 签名
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 一段真实的 1×1 PNG（base64 内联，已被 pngSize 解析验证为 1×1）
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// 角标优先级（PROTOCOL §8.1）
// ---------------------------------------------------------------------------

describe('decideBadge 优先级（PROTOCOL §8.1：running > paused > 结果 > none）', () => {
  test('running 最高优先：即使是 paused 或有失败结果也显示 running', () => {
    assert.equal(decideBadge({ running: true, paused: true, lastRun: { status: 'failure' } }), 'running');
    assert.equal(decideBadge({ running: true, paused: false, lastRun: { status: 'success' } }), 'running');
  });

  test('paused 次之：优先于任何历史结果', () => {
    assert.equal(decideBadge({ running: false, paused: true, lastRun: { status: 'success' } }), 'paused');
    assert.equal(decideBadge({ running: false, paused: true, lastRun: { status: 'failure' } }), 'paused');
    assert.equal(decideBadge({ running: false, paused: true, lastRun: null }), 'paused');
  });

  test('最近结果映射：success / up-to-date / failure / internal-error', () => {
    assert.equal(decideBadge({ running: false, paused: false, lastRun: { status: 'success' } }), 'success');
    assert.equal(decideBadge({ running: false, paused: false, lastRun: { status: 'up-to-date' } }), 'up-to-date');
    assert.equal(decideBadge({ running: false, paused: false, lastRun: { status: 'failure' } }), 'failure');
    assert.equal(
      decideBadge({ running: false, paused: false, lastRun: { status: 'internal-error' } }),
      'failure',
      '内部错误与失败共用红叉',
    );
  });

  test('无历史 / 未知状态 / 空 view → none', () => {
    assert.equal(decideBadge({ running: false, paused: false, lastRun: null }), 'none');
    assert.equal(decideBadge({ running: false, paused: false }), 'none');
    assert.equal(decideBadge({ running: false, paused: false, lastRun: { status: 'weird' } }), 'none');
    assert.equal(decideBadge({}), 'none');
    assert.equal(decideBadge(null), 'none');
    assert.equal(decideBadge(undefined), 'none');
  });

  test('锁定不改变角标（锁定只在菜单标题体现）', () => {
    const base = { running: false, paused: false, lastRun: { status: 'success' } };
    assert.equal(decideBadge({ ...base, locked: true }), decideBadge({ ...base, locked: false }));
  });
});

// ---------------------------------------------------------------------------
// 缓存键（PROTOCOL §8.2）
// ---------------------------------------------------------------------------

describe('cacheKey（PROTOCOL §8.2：sha256(底图) : badge : sizes）', () => {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);

  test('同参数稳定且为 16 位小写十六进制（缓存文件名 <hash 前 16 位>.ico）', () => {
    const k1 = cacheKey(HASH_A, 'success', ICON_SIZES);
    const k2 = cacheKey(HASH_A, 'success', ICON_SIZES);
    assert.equal(k1, k2);
    assert.match(k1, /^[0-9a-f]{16}$/);
  });

  test('底图哈希变化 → 键变化', () => {
    assert.notEqual(cacheKey(HASH_A, 'success', ICON_SIZES), cacheKey(HASH_B, 'success', ICON_SIZES));
  });

  test('角标变化 → 键变化', () => {
    const a = cacheKey(HASH_A, 'success', ICON_SIZES);
    const b = cacheKey(HASH_A, 'failure', ICON_SIZES);
    const c = cacheKey(HASH_A, 'none', ICON_SIZES);
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.notEqual(b, c);
  });

  test('尺寸集合变化 → 键变化；顺序不同也算不同（避免缓存串味）', () => {
    const base = cacheKey(HASH_A, 'paused', [16, 32]);
    assert.notEqual(base, cacheKey(HASH_A, 'paused', [16, 32, 48]));
    assert.notEqual(base, cacheKey(HASH_A, 'paused', [32, 16]));
  });

  test('默认尺寸集合与契约一致（16,20,24,32,40,48,64）', () => {
    assert.deepEqual(ICON_SIZES, [16, 20, 24, 32, 40, 48, 64]);
    assert.equal(cacheKey(HASH_A, 'none'), cacheKey(HASH_A, 'none', ICON_SIZES));
  });

  test('底图哈希为空时用 default 占位（不产生 undefined 字符串外泄）', () => {
    assert.equal(cacheKey(null, 'none', ICON_SIZES), cacheKey('default', 'none', ICON_SIZES));
    assert.equal(cacheKey(undefined, 'none'), cacheKey('default', 'none'));
  });
});

// ---------------------------------------------------------------------------
// pngSize
// ---------------------------------------------------------------------------

describe('pngSize（PROTOCOL §8.2：ICO 条目宽高取自 PNG IHDR）', () => {
  test('真实 1×1 PNG（内联 base64）→ 1×1', () => {
    assert.deepEqual(pngSize(Buffer.from(PNG_1X1_BASE64, 'base64')), { width: 1, height: 1 });
  });

  test('动态生成的多尺寸 PNG → 宽高正确', () => {
    for (const size of [16, 32, 256]) {
      assert.deepEqual(pngSize(makePng(size, size)), { width: size, height: size });
    }
    assert.deepEqual(pngSize(makePng(48, 24)), { width: 48, height: 24 });
  });

  test('非 PNG → null', () => {
    assert.equal(pngSize(Buffer.from('hello world, not a png at all')), null);
    assert.equal(pngSize(Buffer.from([0x00, 0x00, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
    assert.equal(pngSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), null, 'JPEG 魔数不是 PNG');
  });

  test('过短 / 空 / 非 Buffer-ish → null', () => {
    assert.equal(pngSize(Buffer.alloc(0)), null);
    assert.equal(pngSize(Buffer.from([0x89, 0x50, 0x4e])), null);
    assert.equal(pngSize(Buffer.alloc(23)), null);
    assert.equal(pngSize(null), null);
    assert.equal(pngSize(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// buildIco
// ---------------------------------------------------------------------------

describe('buildIco（PROTOCOL §8.2：多尺寸 ICO 打包）', () => {
  test('6 字节头：reserved=0 / type=1(icon) / count=n', () => {
    const ico = buildIco([{ size: 16, data: makePng(16, 16) }, { size: 32, data: makePng(32, 32) }]);
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 2);
  });

  test('每条目录项 16 字节，字段与「偏移连续、总长 = 6+16n+Σdata」都正确', () => {
    const images = [
      { size: 16, data: makePng(16, 16) },
      { size: 24, data: makePng(24, 24) },
      { size: 64, data: makePng(64, 64) },
    ];
    const ico = buildIco(images);
    const n = images.length;
    assert.equal(n, 3);
    assert.equal(ico.length, 6 + 16 * n + images.reduce((s, i) => s + i.data.length, 0));

    let expectedOffset = 6 + 16 * n;
    images.forEach((img, i) => {
      const base = 6 + i * 16;
      assert.equal(ico.readUInt8(base + 0), img.size, `第 ${i} 项宽度`);
      assert.equal(ico.readUInt8(base + 1), img.size, `第 ${i} 项高度`);
      assert.equal(ico.readUInt8(base + 2), 0, '颜色数固定 0');
      assert.equal(ico.readUInt8(base + 3), 0, '保留字节固定 0');
      assert.equal(ico.readUInt16LE(base + 4), 1, 'planes 固定 1');
      assert.equal(ico.readUInt16LE(base + 6), 32, '位深固定 32');
      assert.equal(ico.readUInt32LE(base + 8), img.data.length, `第 ${i} 项数据长度`);
      assert.equal(ico.readUInt32LE(base + 12), expectedOffset, `第 ${i} 项数据偏移必须连续`);
      // 该偏移处的字节必须就是原始 PNG
      assert.deepEqual(ico.subarray(expectedOffset, expectedOffset + img.data.length), img.data);
      expectedOffset += img.data.length;
    });
    assert.equal(expectedOffset, ico.length, '最后一项之后正好结束，无填充残留');
  });

  test('单尺寸也满足公式', () => {
    const data = makePng(16, 16);
    const ico = buildIco([{ size: 16, data }]);
    assert.equal(ico.readUInt16LE(4), 1);
    assert.equal(ico.length, 6 + 16 + data.length);
    assert.equal(ico.readUInt32LE(6 + 12), 22);
  });

  test('256 尺寸在目录里记为 0（ICO 规范：0 表示 256）', () => {
    const ico = buildIco([{ size: 256, data: makePng(256, 256) }]);
    assert.equal(ico.readUInt8(6 + 0), 0, '宽 256 → 0');
    assert.equal(ico.readUInt8(6 + 1), 0, '高 256 → 0');
  });

  test('data 不是可解析 PNG 时回退用 size 字段填宽高', () => {
    const fake = Buffer.alloc(10, 0xab); // 无 PNG 签名
    const ico = buildIco([{ size: 20, data: fake }]);
    assert.equal(ico.readUInt8(6 + 0), 20);
    assert.equal(ico.readUInt8(6 + 1), 20);
    assert.equal(ico.readUInt32LE(6 + 8), fake.length);
  });

  test('空数组 → 只有 6 字节头，count=0', () => {
    const ico = buildIco([]);
    assert.equal(ico.length, 6);
    assert.equal(ico.readUInt16LE(4), 0);
  });
});
