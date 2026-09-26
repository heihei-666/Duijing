/**
 * 对镜 · 推送订阅 hook
 *
 * 方案 3.9：**默认不推送**，唯一例外是用户主动预约的辩论提醒。
 * 所以这个 hook 只做一件事——把「这台设备能不能收到提醒」这件事
 * 如实、可验证地管起来，不做任何自动订阅、不做任何挽留式弹窗。
 *
 * 完整链路（缺一步都会变成「用户以为开了，其实没开」）：
 *   1. 环境探测：Service Worker + PushManager + Notification，以及 iOS 的
 *      「必须先添加到主屏幕」（见 env.ts）
 *   2. Notification.requestPermission()
 *   3. registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
 *      —— 公钥要 base64url → Uint8Array（见 vapid.ts）
 *   4. 把订阅 POST 给后端 /api/push/subscribe
 *
 * 任何一步失败都返回 false 并留下中文说明，绝不静默成功。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getPushConfig,
  getPushStatus,
  sendTestPush,
  subscribePush,
  unsubscribePush,
  type PushConfig,
  type PushSubscribePayload,
  type ReminderPreset,
} from './api';
import { detectPushEnvironment, type PushEnvironment } from './env';
import { bufferToBase64Url, isSameApplicationServerKey, urlBase64ToUint8Array } from './vapid';

export type PushBusy = 'enable' | 'disable' | 'test' | null;
export type PushPermissionState = NotificationPermission | 'unsupported';

export interface UsePushNotificationsResult {
  environment: PushEnvironment;
  config: PushConfig | null;
  presets: ReminderPreset[];
  /** 首次读取 config / status 中 */
  loading: boolean;
  /** 当前正在执行的动作 */
  busy: PushBusy;
  error: string | null;
  notice: string | null;
  permission: PushPermissionState;
  /** 这台设备已经登记到服务端（开关的 on 状态） */
  subscribed: boolean;
  /** 浏览器本地已有订阅，但未必登记在当前账号下 */
  localSubscribed: boolean;
  /** 服务端记录的订阅设备数（含其它设备） */
  deviceCount: number;
  /** 具备开启条件：浏览器支持 && 服务端配置了 VAPID 公钥 */
  canEnable: boolean;
  refresh: () => Promise<void>;
  enable: () => Promise<boolean>;
  disable: () => Promise<boolean>;
  sendTest: () => Promise<boolean>;
  clearMessages: () => void;
}

interface UsePushNotificationsOptions {
  /**
   * 挂载时是否立刻读取 config / status（默认 true）。
   * 辩论房这类只是「偶尔用到」的页面传 false，避免每次进房间都多两个请求；
   * 打开预约面板时再 refresh()。
   */
  auto?: boolean;
}

/** Service Worker 就绪的最长等待时间；dev 下没注册 SW 时不能一直挂着 */
const SW_READY_TIMEOUT_MS = 10_000;

function readPermission(): PushPermissionState {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

function describe(cause: unknown, fallback = '操作失败，请稍后再试'): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * 订阅失败时，浏览器抛的是 DOMException，message 是英文的。
 * 直接把 "The request is not allowed..." 摆给用户没有意义，按 name 翻成能照做的话。
 */
function describeEnableFailure(cause: unknown): string {
  if (cause instanceof DOMException) {
    if (cause.name === 'NotAllowedError') {
      return '通知权限被拒绝了。需要到浏览器（或系统）设置里重新允许本站通知，再回来开启。';
    }
    if (cause.name === 'AbortError') {
      return '订阅过程被中断了，请再试一次。';
    }
    if (cause.name === 'InvalidStateError') {
      return '这台设备的订阅状态异常，刷新页面后再试一次。';
    }
  }
  return describe(cause, '开启通知失败，请稍后再试');
}

/** 给「等一个可能永远不 resolve 的 promise」加个上限，失败也要有话说 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        window.clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(message));
      },
    );
  });
}

/**
 * `Notification.requestPermission()` 在新浏览器返回 Promise，
 * 老 Safari 只支持回调式。两种都兜住，且保证只 resolve 一次。
 */
function requestNotificationPermission(): Promise<NotificationPermission> {
  return new Promise<NotificationPermission>((resolve) => {
    let settled = false;
    const done = (permission: NotificationPermission) => {
      if (settled) return;
      settled = true;
      resolve(permission);
    };

    try {
      const maybe = Notification.requestPermission(done);
      if (maybe && typeof maybe.then === 'function') {
        maybe.then(done).catch(() => done(Notification.permission));
      }
    } catch {
      done(Notification.permission);
    }
  });
}

/** 等 Service Worker 就绪；没有注册（例如 dev）时给一句能照做的提示 */
async function waitForRegistration(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('当前浏览器不支持 Service Worker，无法接收通知。');
  }
  return withTimeout(
    navigator.serviceWorker.ready,
    SW_READY_TIMEOUT_MS,
    '通知服务还没准备好，请刷新页面后再试一次。',
  );
}

/** 只读取本地订阅状态，不等待 ready、不抛错 */
async function readLocalSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return null;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** PushSubscription → 后端要的 { endpoint, keys: { p256dh, auth } } */
function toSubscribePayload(subscription: PushSubscription): PushSubscribePayload {
  const json = subscription.toJSON();
  const endpoint = json.endpoint ?? subscription.endpoint;
  // 绝大多数浏览器 toJSON() 就带 keys；缺失时直接从订阅里取原始字节再编码，
  // 而不是把一个残缺的订阅发给后端（后端会 400「推送订阅信息不完整」）。
  const p256dh = json.keys?.p256dh ?? encodeKey(subscription.getKey('p256dh'));
  const auth = json.keys?.auth ?? encodeKey(subscription.getKey('auth'));

  if (!endpoint || !p256dh || !auth) {
    throw new Error('浏览器返回的订阅信息不完整，请刷新页面后重试。');
  }
  return { endpoint, keys: { p256dh, auth } };
}

function encodeKey(key: ArrayBuffer | null): string {
  return key ? bufferToBase64Url(key) : '';
}

export function usePushNotifications(
  options: UsePushNotificationsOptions = {},
): UsePushNotificationsResult {
  const auto = options.auto !== false;
  const environment = useMemo(() => detectPushEnvironment(), []);

  const [config, setConfig] = useState<PushConfig | null>(null);
  const [loading, setLoading] = useState(auto);
  const [busy, setBusy] = useState<PushBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [permission, setPermission] = useState<PushPermissionState>(() => readPermission());
  const [localSubscribed, setLocalSubscribed] = useState(false);
  const [deviceCount, setDeviceCount] = useState(0);

  /** 组件卸载后不再 setState（用户可能在权限弹窗上停留很久） */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await getPushConfig();
      if (!aliveRef.current) return;
      setConfig(loaded);

      const status = await getPushStatus();
      if (!aliveRef.current) return;
      setDeviceCount(status.device_count);

      setPermission(readPermission());
      setLocalSubscribed((await readLocalSubscription()) !== null);
    } catch (cause) {
      if (aliveRef.current) setError(describe(cause, '通知状态读取失败'));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!auto) return;
    void refresh();
  }, [auto, refresh]);

  /** config 还没拉过就现拉一次；enable() 不依赖调用方先 refresh */
  const ensureConfig = useCallback(async (): Promise<PushConfig> => {
    if (config) return config;
    const loaded = await getPushConfig();
    if (aliveRef.current) setConfig(loaded);
    return loaded;
  }, [config]);

  const enable = useCallback(async (): Promise<boolean> => {
    setError(null);
    setNotice(null);

    if (!environment.supported) {
      setError(environment.hint ?? '当前环境不支持通知。');
      return false;
    }

    setBusy('enable');
    try {
      const loaded = await ensureConfig();
      if (!loaded.available || !loaded.public_key) {
        setError('服务端还没有配置推送密钥，暂时无法开启通知。');
        return false;
      }

      // ① 权限；用户拒绝过就只能去浏览器设置里改，这里如实说明
      const granted = await requestNotificationPermission();
      if (aliveRef.current) setPermission(granted);
      if (granted !== 'granted') {
        setError(
          granted === 'denied'
            ? '通知权限被拒绝了。需要在浏览器（或系统）设置里重新允许本站通知，再回来开启。'
            : '没有拿到通知权限，可以稍后再试。',
        );
        return false;
      }

      // ② 订阅
      const registration = await waitForRegistration();
      const applicationServerKey = urlBase64ToUint8Array(loaded.public_key);
      let subscription = await registration.pushManager.getSubscription();

      // 服务端换过 VAPID 密钥的话，旧订阅是发不出去的：先退掉再重订
      if (
        subscription &&
        !isSameApplicationServerKey(subscription.options?.applicationServerKey, applicationServerKey)
      ) {
        await subscription.unsubscribe();
        subscription = null;
      }

      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          // 必须为 true：iOS / Chrome 都要求每条推送对用户可见
          userVisibleOnly: true,
          applicationServerKey,
        });
      }

      // ③ 登记到服务端
      const result = await subscribePush(toSubscribePayload(subscription));
      if (!aliveRef.current) return true;
      setLocalSubscribed(true);
      setDeviceCount(result.device_count);
      setNotice('已开启。到你约的时间我会来叫你。');
      return true;
    } catch (cause) {
      if (aliveRef.current) setError(describeEnableFailure(cause));
      return false;
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  }, [ensureConfig, environment]);

  const disable = useCallback(async (): Promise<boolean> => {
    setError(null);
    setNotice(null);
    setBusy('disable');
    try {
      const registration = await waitForRegistration();
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        // 先告知服务端再退本地订阅：服务端调用失败时本地订阅还在，
        // 状态不会出现「本地以为关了、服务端还在发」的漂移
        await unsubscribePush(subscription.endpoint);
        await subscription.unsubscribe();
      }
      const status = await getPushStatus();
      if (!aliveRef.current) return true;
      setLocalSubscribed(false);
      setDeviceCount(status.device_count);
      setNotice('已关闭。这台设备不会再收到任何通知。');
      return true;
    } catch (cause) {
      if (aliveRef.current) setError(describe(cause, '关闭通知失败，请稍后再试'));
      return false;
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  }, []);

  const sendTest = useCallback(async (): Promise<boolean> => {
    setError(null);
    setNotice(null);
    setBusy('test');
    try {
      const result = await sendTestPush();
      if (aliveRef.current) {
        setNotice(`测试通知已发出（${result.delivered} 台设备）。没看到的话，检查一下系统通知有没有被静音。`);
      }
      return true;
    } catch (cause) {
      if (aliveRef.current) setError(describe(cause, '测试通知发送失败'));
      return false;
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  }, []);

  const clearMessages = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  const presets = useMemo(() => config?.presets ?? [], [config]);

  return {
    environment,
    config,
    presets,
    loading,
    busy,
    error,
    notice,
    permission,
    subscribed: permission === 'granted' && localSubscribed && deviceCount > 0,
    localSubscribed,
    deviceCount,
    canEnable: environment.supported && config?.available === true,
    refresh,
    enable,
    disable,
    sendTest,
    clearMessages,
  };
}
