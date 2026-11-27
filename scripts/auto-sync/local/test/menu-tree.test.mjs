// menu-tree.test.mjs — 托盘右键菜单的层级契约
//
// 需求来源：用户给定的菜单树（.tmp/新建文件.txt）。
// 这里直接启动 tray.ps1 -TestMenu 导出真实菜单树再断言，
// 不再只检查脚本能否解析——平铺、挪位、丢外层都会让测试失败。
//
// 只在 Windows 上运行；GHA 不跑本目录测试。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRAY = path.resolve(HERE, '..', 'tray.ps1');
const SKIP = process.platform !== 'win32';

/** 运行 -TestMenu 并解析 JSON 菜单树（不读写用户 config.json / state.json） */
function readMenuTree() {
  const result = spawnSync(
    'powershell.exe',
    ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TRAY, '-TestMenu'],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 },
  );
  assert.equal(result.status, 0, `tray.ps1 -TestMenu 退出码异常：${result.stderr || ''}`);
  const text = String(result.stdout || '').trim();
  assert.ok(text, '没有输出菜单树');
  return JSON.parse(text);
}

/** 把菜单树拍平成 "父/子/孙" 路径列表（不含分隔线） */
function flatten(nodes, prefix = '', out = []) {
  for (const node of nodes) {
    if (node === '---') continue;
    const text = typeof node === 'string' ? node : node.Text;
    const full = prefix ? `${prefix}/${text}` : text;
    out.push(full);
    if (typeof node === 'object' && Array.isArray(node.Children)) flatten(node.Children, full, out);
  }
  return out;
}

/** 某个菜单节点（按完整路径）的子项文本数组；不存在则返回 null */
function childrenOf(nodes, target, prefix = '') {
  for (const node of nodes) {
    if (node === '---') continue;
    const text = typeof node === 'string' ? node : node.Text;
    const full = prefix ? `${prefix}/${text}` : text;
    if (full === target) return typeof node === 'object' ? node.Children.map((c) => (typeof c === 'string' ? c : c.Text)) : [];
    if (typeof node === 'object' && Array.isArray(node.Children)) {
      const found = childrenOf(node.Children, target, full);
      if (found) return found;
    }
  }
  return null;
}

test('真实菜单树：顶层结构', { skip: SKIP }, () => {
  const tree = readMenuTree();
  const top = tree.filter((n) => n !== '---').map((n) => (typeof n === 'string' ? n : n.Text));

  assert.equal(top[0], 'fdn-autosync-tray', '首项应为程序名');
  assert.ok(top.includes('立即同步'), '缺少「立即同步」');
  assert.ok(top.includes('暂停自动同步'), '缺少「暂停自动同步」');
  assert.ok(top.includes('锁定'), '缺少「锁定」');
  assert.ok(top.includes('浏览'), '缺少「浏览」子菜单');
  assert.ok(top.includes('配置'), '缺少「配置」子菜单');
  assert.ok(top.includes('重启') && top.includes('退出'), '缺少「重启」/「退出」');

  // 配置文件与日志文件夹必须收在「浏览」里，不能同时出现在顶层
  assert.ok(!top.includes('配置文件'), '顶层不应出现「配置文件」，应在「浏览」下');
  assert.ok(!top.includes('日志文件夹'), '顶层不应出现「日志文件夹」，应在「浏览」下');
});

test('真实菜单树：浏览只含配置文件与日志文件夹', { skip: SKIP }, () => {
  const tree = readMenuTree();
  assert.deepEqual(childrenOf(tree, '浏览'), ['配置文件', '日志文件夹']);
});

test('真实菜单树：部署 → 托盘外观 → 图标 保留嵌套', { skip: SKIP }, () => {
  const tree = readMenuTree();
  assert.deepEqual(childrenOf(tree, '配置/部署/托盘外观/图标'), ['选择图片…', '重置']);

  const deployment = childrenOf(tree, '配置/部署');
  assert.ok(deployment.includes('开机自启'), '部署下缺「开机自启」');
  assert.ok(deployment.includes('启动后同步一次'), '部署下缺「启动后同步一次」');
  // 图标项不得被平铺到「部署」层
  assert.ok(!deployment.includes('选择图片…'), '「选择图片…」不应平铺在部署下');
  assert.ok(!deployment.includes('重置'), '「重置」不应平铺在部署下');
});

test('真实菜单树：准备阶段保留「无网时连指定WiFi」外层', { skip: SKIP }, () => {
  const tree = readMenuTree();
  const prepare = childrenOf(tree, '配置/准备阶段');
  assert.deepEqual(prepare, ['无网时连指定WiFi'], '准备阶段下应只有这个外套子菜单');

  assert.deepEqual(childrenOf(tree, '配置/准备阶段/无网时连指定WiFi'), [
    '总开关', '设定SSID…', '设定密码…', '优先使用已保存密码', '不检查网络，总是连', '失败时跳过整次',
  ]);
});

test('真实菜单树：各阶段与结束阶段的层级', { skip: SKIP }, () => {
  const tree = readMenuTree();
  const all = flatten(tree);

  // 文件里写的是小写英文 + 中文小标题，不能擅自改成「Pull 阶段」
  assert.ok(all.includes('配置/pull阶段'), 'pull 阶段标题应为「pull阶段」');
  assert.ok(all.includes('配置/pull阶段/变基模式/rebase'));
  assert.ok(all.includes('配置/pull阶段/变基模式/ff-only'));
  assert.ok(all.includes('配置/sync阶段/设定H1111_SESSION…'));
  assert.ok(all.includes('配置/sync阶段/设定GH_TOKEN…'));
  assert.ok(all.includes('配置/commit阶段/git身份/GHA'));
  assert.ok(all.includes('配置/commit阶段/git身份/设定自定义邮箱…'));
  assert.ok(all.includes('配置/push阶段/设定PUSH_TOKEN…'));

  assert.deepEqual(childrenOf(tree, '配置/结束阶段/断开指定WiFi'), ['无论是否成功，断开指定WiFi', '并忘记']);
  assert.deepEqual(childrenOf(tree, '配置/结束阶段/通知/标准模式设置'), ['成功', '已是最新', '失败', '内部错误']);
  assert.deepEqual(childrenOf(tree, '配置/结束阶段/通知/累积模式设置/内部错误处理'), ['总是弹出', '不弹出']);

  assert.ok(all.includes('配置/杂项/设定日志保留天数…'));
  assert.ok(all.includes('配置/杂项/设定锁定密码…'));
  assert.ok(all.includes('配置/设定间隔(min)…'));
});

test('真实菜单树：首次启动不显示上次同步信息', { skip: SKIP }, () => {
  const tree = readMenuTree();
  const info = tree.filter((n) => typeof n === 'string');
  assert.ok(!info.some((t) => t.startsWith('上次')), `未同步时不应出现「上次」行，实际：${info.join(' | ')}`);
  assert.ok(info.some((t) => t.startsWith('自启动后已同步')), '缺少同步次数');
  assert.ok(info.some((t) => t.startsWith('下次在')), '缺少下次时间');
});