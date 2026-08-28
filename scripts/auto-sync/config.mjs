// config.mjs — 线路1 自动同步：环境变量与全局常量
// 仅从环境变量读凭据（GHA secret 注入 / 本地手动 export），仓库内不落任何凭据。

export const ENV = {
  // 网盘 API（默认线上源，测试可覆盖）
  HOST: (process.env.H1111_HOST || 'https://pan.huang1111.cn').replace(/\/+$/, ''),
  USER: process.env.H1111_USER || '',
  PASSWORD: process.env.H1111_PASSWORD || '',
  // GitHub 相关（GHA 自动注入；本地运行时可不带）
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY || '',
  GITHUB_REF_NAME: process.env.GITHUB_REF_NAME || '',
  IS_GHA: process.env.GITHUB_ACTIONS === 'true',
  // 单个版本的离线下载轮询上限（毫秒），可按需覆盖
  DOWNLOAD_TIMEOUT_MS: Number(process.env.AUTO_SYNC_DOWNLOAD_TIMEOUT_MS || 20 * 60 * 1000),
};

// 重试策略（用户确认的口径："重试 N 次" = 最多尝试 N 次，与验证码 10 次尝试的实现一致）
export const RETRY = {
  CAPTCHA_ATTEMPTS: 10, // 验证码类失败（登录、取直链）：每次换新验证码，最多 10 次
  DOWNLOAD_ATTEMPTS: 3, // 离线下载失败：整段「提交+轮询」最多 3 次
  GENERIC_ATTEMPTS: 2,  // 其他任何失败（网络/接口异常）：最多 2 次
};

export const TIMING = {
  POLL_INTERVAL_MS: 5000,    // 离线下载轮询间隔
  CAPTCHA_COOLDOWN_MS: 800,  // 验证码重试间隔
};

// 批量提交上限（huang1111 对离线下载任务数有限制，需分批提交）
export const LIMIT = {
  OFFLINE_BATCH: 5, // 离线下载每批提交的 URL 数
};