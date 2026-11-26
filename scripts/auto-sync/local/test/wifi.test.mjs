// wifi.test.mjs — netsh 输出解析与 WLAN 配置 XML 生成
//
// 对应设计文档 §9（WiFi 阶段）与 PROTOCOL.md §7（设置页 WiFi 字段）：
//   · parseInterfaces 要能解析中文（状态 : 已连接）与英文（State : connected）的 netsh 输出
//   · 未连接时 connected=false（不能让 UI 误报已连接）
//   · buildProfileXml 必须做 XML 转义（SSID/密码里的 & < > " ' 不能破坏 XML，更不能注入）
// 只测纯函数，不调用 netsh / 不联网。

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseInterfaces, buildProfileXml } from '../modules/wifi.mjs';

// ---------------------------------------------------------------------------
// parseInterfaces
// ---------------------------------------------------------------------------

describe('parseInterfaces（中文 netsh 输出）', () => {
  const CHINESE_CONNECTED = [
    '',
    '接口名称: Wi-Fi',
    '',
    '    名称                   : Wi-Fi',
    '    描述                   : Intel(R) Wi-Fi 6 AX201 160MHz',
    '    GUID                   : 12345678-1234-1234-1234-1234567890ab',
    '    物理地址               : aa:bb:cc:dd:ee:ff',
    '    状态                   : 已连接',
    '    SSID                   : MyHome-5G',
    '    BSSID                  : aa:bb:cc:dd:ee:ff',
    '    网络类型               : 结构',
    '    无线电类型             : 802.11ax',
    '    信号                   : 99%',
    '',
  ].join('\r\n');

  test('「SSID : X」+「状态 : 已连接」→ connected=true 且 SSID 正确', () => {
    const st = parseInterfaces(CHINESE_CONNECTED);
    assert.equal(st.connected, true);
    assert.equal(st.ssid, 'MyHome-5G');
    assert.equal(st.state, '已连接');
  });

  test('繁体「已連線」也能识别为已连接', () => {
    const text = '    狀態                   : 已連線\r\n    SSID                   : OfficeNet\r\n';
    const st = parseInterfaces(text);
    assert.equal(st.connected, true);
    assert.equal(st.ssid, 'OfficeNet');
  });

  test('「状态 : 已断开」→ connected=false（即使有 SSID 残留行）', () => {
    const text = '    状态                   : 已断开\r\n    SSID                   : MyHome-5G\r\n';
    const st = parseInterfaces(text);
    assert.equal(st.connected, false);
    assert.equal(st.state, '已断开');
  });

  test('完全没有接口（无 SSID、无状态行）→ connected=false、字段为空串', () => {
    const st = parseInterfaces('    Name                   : Wi-Fi\r\n    状态                   : 已断开\r\n');
    assert.deepEqual(st, { connected: false, ssid: '', state: '已断开' });
  });
});

describe('parseInterfaces（英文 netsh 输出）', () => {
  test('「State : connected」+「SSID : Office2G」→ connected=true', () => {
    const text = [
      '',
      '    Name                   : Wi-Fi',
      '    Description            : Realtek 8822CE Wireless LAN',
      '    State                  : connected',
      '    SSID                   : Office2G',
      '    BSSID                  : 11:22:33:44:55:66',
      '    Signal                 : 78%',
      '',
    ].join('\n');
    const st = parseInterfaces(text);
    assert.equal(st.connected, true);
    assert.equal(st.ssid, 'Office2G');
    assert.equal(st.state, 'connected');
  });

  test('「SSID」行不会被「BSSID」行误匹配', () => {
    const text = '    State                  : connected\n    BSSID                  : 11:22:33:44:55:66\n';
    const st = parseInterfaces(text);
    assert.equal(st.ssid, '', '只有 BSSID 时不能把 MAC 当成 SSID');
  });

  test('没有状态行、但 SSID 存在且未出现断开字样 → 视为已连接（容错）', () => {
    const st = parseInterfaces('    SSID                   : LegacyNet\n');
    assert.equal(st.ssid, 'LegacyNet');
    assert.equal(st.connected, true);
  });

  test('空输入 / null → 默认未连接', () => {
    for (const v of ['', null, undefined]) {
      assert.deepEqual(parseInterfaces(v), { connected: false, ssid: '', state: '' });
    }
  });

  // ⚠ 已知产品缺陷（未擅自修改，见最终报告）：
  //   wifi.mjs 用 /已连接|已連線|connected/i 匹配状态值，而 "disconnected" 含有子串 "connected"，
  //   于是英文 Windows 上「State : disconnected」被误判为「已连接」。
  //   修复建议：改成精确匹配（/^(已连接|已連線|connected)$/i）或先排除 disconnected。
  test('英文「State : disconnected」应判为未连接', () => {
    const text = '    State                  : disconnected\n    SSID                   : Office2G\n';
    const st = parseInterfaces(text);
    assert.equal(st.connected, false, 'disconnected 不能被判为已连接');
  });
});

// ---------------------------------------------------------------------------
// buildProfileXml
// ---------------------------------------------------------------------------

describe('buildProfileXml（PROTOCOL §9 / 设计 §9：WPA2-PSK 配置 XML）', () => {
  test('标准结构：名称出现两次、WPA2PSK/AES、含 <keyMaterial>', () => {
    const xml = buildProfileXml('MyHome-5G', 'passw0rd');
    assert.match(xml, /^<\?xml version="1\.0"\?>/);
    assert.ok(xml.includes('<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">'));
    assert.ok(xml.includes('<authentication>WPA2PSK</authentication>'));
    assert.ok(xml.includes('<encryption>AES</encryption>'));
    assert.ok(xml.includes('<keyType>passPhrase</keyType>'));
    assert.ok(xml.includes('<keyMaterial>passw0rd</keyMaterial>'));
    // SSID 名称：<name> 与 <SSID><name> 两处
    assert.equal((xml.match(/<name>MyHome-5G<\/name>/g) || []).length, 2);
    assert.match(xml, /<connectionType>ESS<\/connectionType>/);
    assert.match(xml, /<connectionMode>auto<\/connectionMode>/);
  });

  test('SSID 与密码里的 & < > " \' 都被转义，且没有裸 & （XML 必须能解析）', () => {
    const ssid = `A&B <Net> "双引号" '单引号'`;
    const password = `p&ss<w>o"r'd`;

    const xml = buildProfileXml(ssid, password);

    assert.ok(xml.includes('&amp;'), '& 必须转义');
    assert.ok(xml.includes('&lt;'), '< 必须转义');
    assert.ok(xml.includes('&gt;'), '> 必须转义');
    assert.ok(xml.includes('&quot;'), '" 必须转义');
    assert.ok(xml.includes('&apos;'), "' 必须转义");
    assert.ok(!xml.includes(ssid), '原文（含裸 &）不得直接出现在 XML 里');
    assert.ok(!xml.includes(password), '密码原文不得直接出现');

    // 不存在「不是实体的裸 &」：每个 & 后面必须紧跟已知实体名
    const bareAmp = xml.match(/&(?!(amp|lt|gt|quot|apos);)/g);
    assert.equal(bareAmp, null, `存在未转义的裸 &：${JSON.stringify(bareAmp)}`);

    // keyMaterial 里装的是转义后的密码
    assert.ok(xml.includes('<keyMaterial>p&amp;ss&lt;w&gt;o&quot;r&apos;d</keyMaterial>'));
  });

  test('转义顺序正确：先 & 再其它（避免 &amp;lt; 双重转义）', () => {
    const xml = buildProfileXml('a&b', 'x');
    assert.ok(xml.includes('<name>a&amp;b</name>'));
    assert.ok(!xml.includes('&amp;amp;'));
  });

  test('空 SSID / 空密码不报错（结构仍合法）', () => {
    const xml = buildProfileXml('', '');
    assert.ok(xml.includes('<name></name>'));
    assert.ok(xml.includes('<keyMaterial></keyMaterial>'));
    assert.ok(!xml.includes('undefined'));
    assert.ok(!xml.includes('null'));
  });

  test('HTML 注入样式的内容不会形成新标签', () => {
    const xml = buildProfileXml('<name>evil</name>', '<keyMaterial>x</keyMaterial>');
    // 只应出现 XML 自身的 2 个 <name> 和 1 个 <keyMaterial>
    assert.equal((xml.match(/<name>/g) || []).length, 2);
    assert.equal((xml.match(/<keyMaterial>/g) || []).length, 1);
    assert.ok(xml.includes('&lt;name&gt;evil&lt;/name&gt;'));
  });
});