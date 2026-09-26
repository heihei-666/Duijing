/**
 * 对镜 · 推送环境探测
 *
 * Web Push 在浏览器里的可用性是**分环境**的，而且失败时几乎没有反馈：
 * 用户点了开关、界面看着像开了，到点却什么都没有。所以开启之前先把
 * 「这台设备到底行不行、不行是为什么」判定清楚，并且给出一句
 * 用户能照着做的说明，而不是一句「不支持」。
 *
 * 几个必须区分的情况：
 *   · 非安全上下文（http 且非 localhost）：Push API 根本不存在
 *   · iOS Safari 普通标签页：iOS 16.4+ 才支持 Web Push，且**必须**先把网页
 *     添加到主屏幕、再从主屏幕图标打开；在 Safari 标签页里 `PushManager`
 *     是 undefined，此时说「浏览器不支持」是误导
 *   · 桌面/安卓的旧浏览器：确实不支持
 */

export type PushBlockedReason = 'insecure' | 'ios_needs_install' | 'browser' | null;

export interface PushEnvironment {
  /** 浏览器层面具备 Service Worker + PushManager + Notification */
  supported: boolean;
  /** iOS 上「添加到主屏幕」之后才支持推送（此时 supported 为 false） */
  needsInstall: boolean;
  /** 安全上下文（https 或 localhost） */
  secure: boolean;
  /** 不可用时是哪种情况；可用时为 null */
  blockedReason: PushBlockedReason;
  /** 给用户看的一句话说明；不需要说明时为 null */
  hint: string | null;
}

const IOS_INSTALL_HINT =
  'iPhone / iPad 需要先「添加到主屏幕」，再从主屏幕打开对镜，才能开启通知：' +
  '用 Safari 打开后点底部的分享按钮 → 添加到主屏幕。';

const INSECURE_HINT = '当前不是安全连接（https），浏览器不允许发通知。请用 https 地址打开对镜。';

const BROWSER_HINT = '当前环境不支持通知。可以换用 Chrome / Edge / Safari 新版，或把对镜添加到主屏幕后再试。';

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ 的 Safari 默认伪装成 macOS，靠「Mac + 触摸点」识别
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** 已经以「独立应用」形式打开（iOS 的添加到主屏幕 / 桌面 PWA） */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS Safari 私有的 navigator.standalone
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** 探测当前环境的推送可用性。纯函数，不请求任何权限。 */
export function detectPushEnvironment(): PushEnvironment {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      supported: false,
      needsInstall: false,
      secure: false,
      blockedReason: 'browser',
      hint: BROWSER_HINT,
    };
  }

  // Push API 只在安全上下文里存在：https 或 localhost。
  // 三个条件任一成立即可——`isSecureContext` 有个别环境不实现，
  // 而 https 部署下 `location.protocol` 一定是 'https:'。
  const secure =
    window.isSecureContext === true ||
    window.location.protocol === 'https:' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';

  const hasApi =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const ios = isIos();
  const installable = ios && !isStandalone();

  if (!secure) {
    return {
      supported: false,
      needsInstall: installable,
      secure: false,
      blockedReason: 'insecure',
      hint: INSECURE_HINT,
    };
  }

  if (hasApi) {
    return { supported: true, needsInstall: false, secure: true, blockedReason: null, hint: null };
  }

  // iOS 标签页里 PushManager 是 undefined，但这不是「浏览器不行」，而是「还没装到桌面」
  if (installable) {
    return {
      supported: false,
      needsInstall: true,
      secure: true,
      blockedReason: 'ios_needs_install',
      hint: IOS_INSTALL_HINT,
    };
  }

  return {
    supported: false,
    needsInstall: false,
    secure: true,
    blockedReason: 'browser',
    hint: BROWSER_HINT,
  };
}
