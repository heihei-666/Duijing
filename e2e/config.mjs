/**
 * 端到端验收脚本的公共配置。
 *
 * 设计原则：**脚本本身不含任何密钥、服务器 IP、邀请码或本机路径**，
 * 环境相关的值一律从环境变量读。这样这些脚本可以安全地留在仓库里，
 * 谁拿到仓库都能跑，不会因为源码里躺着凭据而被迫私有化。
 *
 * 变量清单与用法见 e2e/README.md。
 */

/** 被测站点。默认生产域名 —— 域名本身不是秘密，deploy/DEPLOY.md 里也写了。 */
export const BASE = (process.env.DJ_BASE ?? 'https://duijing.xyz').replace(/\/+$/, '');

/**
 * 注册邀请码。
 *
 * 刻意**不给默认值**：邀请码是「谁能注册」的凭证，一旦写进仓库就等于公开。
 * 用 requireInvite() 在真正需要时才校验，缺了就退出并说清楚怎么拿。
 */
export const INVITE = process.env.DJ_INVITE ?? '';

export function requireInvite() {
  if (!INVITE) {
    console.error(
      '\n  ✗ 缺少环境变量 DJ_INVITE（注册邀请码）。\n' +
        '    获取方式：站长登录 → 资产页 → 邀请码。\n' +
        '    用法：DJ_INVITE=XXXXXXX node e2e/accept.mjs\n',
    );
    process.exit(2);
  }
  return INVITE;
}

/** 一次性测试账号的密码。这些账号跑完即删，不是任何真实账号的口令。 */
export const TEST_PASSWORD = process.env.DJ_TEST_PASSWORD ?? 'E2eTest12345';

/** 截图输出目录。 */
export const SHOTS = process.env.DJ_SHOTS ?? new URL('./shots/', import.meta.url).pathname;

/** 结果 JSON 输出目录。 */
export const OUT = process.env.DJ_OUT ?? new URL('./', import.meta.url).pathname;

/**
 * 直连服务器做状态校验时用的 SSH 命令（可选）。
 *
 * 留空则脚本跳过所有数据库断言，只做纯浏览器验收 —— 这样别人拿到仓库
 * 不配 SSH 也能跑通大部分检查。示例值见 e2e/README.md。
 */
export const SSH = process.env.DJ_SSH ?? '';

/** 服务器上 SQLite 的路径（配合 DJ_SSH 使用）。 */
export const DB = process.env.DJ_DB ?? '/opt/duijing/data/duijing.db';

/** 无头 Chromium 的启动参数。容器里跑必须带 --no-sandbox。 */
export const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
];

/** 移动端视口：整个产品是移动优先的，验收也按手机尺寸来。 */
export const MOBILE_VIEWPORT = { width: 390, height: 844 };
