/**
 * 对镜 · 推送订阅 API 适配层
 *
 * `@/api/client` 与 `@/api/types` 由同事维护、本次交付不允许改动，
 * 且里面**没有** push 相关的方法（已在交付报告里列出）。
 * 这里复用 client.ts 导出的 `apiRequest`，因此 Cookie、401 跳转、
 * FastAPI 中文 detail 的解析行为与其它模块完全一致。
 *
 * 服务端实现：app/api/push.py
 */

import { apiRequest } from '@/api/client';

export interface ReminderPreset {
  key: string;
  label: string;
}

/** `GET /api/push/config`（不需要登录，登录前就要能判断环境） */
export interface PushConfig {
  /** 服务端是否已生成 VAPID 密钥；false 时前端只提示，不报错 */
  available: boolean;
  public_key: string | null;
  presets: ReminderPreset[];
}

/** `GET /api/push/status` */
export interface PushStatus {
  available: boolean;
  subscribed: boolean;
  device_count: number;
}

export interface PushSubscribePayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function getPushConfig(): Promise<PushConfig> {
  return apiRequest<PushConfig>('/push/config');
}

export function getPushStatus(): Promise<PushStatus> {
  return apiRequest<PushStatus>('/push/status');
}

export function subscribePush(
  payload: PushSubscribePayload,
): Promise<{ ok: boolean; device_count: number }> {
  return apiRequest<{ ok: boolean; device_count: number }>('/push/subscribe', {
    method: 'POST',
    body: payload,
  });
}

export function unsubscribePush(endpoint: string): Promise<{ ok: boolean; removed: boolean }> {
  return apiRequest<{ ok: boolean; removed: boolean }>('/push/unsubscribe', {
    method: 'POST',
    body: { endpoint },
  });
}

/** 给自己发一条测试推送；没有可用设备时后端返回 409 + 中文说明 */
export function sendTestPush(): Promise<{ ok: boolean; delivered: number }> {
  return apiRequest<{ ok: boolean; delivered: number }>('/push/test', { method: 'POST' });
}
