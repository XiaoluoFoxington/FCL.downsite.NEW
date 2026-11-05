// session-status.mjs — 供本地托盘读取「会话 cookie 还剩多久」的小工具
//
// 只做离线推算（cookie 内嵌签发时间 + 60 天常量），不发任何网络请求。
// 输出一行 JSON，由 tray.ps1 解析后显示在托盘菜单/气泡里。
//
// 运行：node scripts/auto-sync/local/session-status.mjs
// 凭据：环境变量 H1111_SESSION（由 tray.ps1 从 config.json 注入）

import { sessionInfo, fmtUnixCST, fmtRemaining } from '../session.mjs';

const info = sessionInfo(process.env.H1111_SESSION || '');

const payload = {
  present: info.present,
  parseable: info.parseable,
  valid: info.valid,
  daysLeft: info.daysLeft,
  remaining: info.parseable ? fmtRemaining(info.secondsLeft) : null,
  expires: info.parseable ? fmtUnixCST(info.expiresAt) : null,
  reason: info.reason,
};

process.stdout.write(JSON.stringify(payload) + '\n');
