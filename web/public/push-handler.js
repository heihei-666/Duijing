/**
 * 对镜 · Service Worker 里的推送处理
 *
 * 这个文件不在 web/src 下，也不会被打包：它由 `public/` 原样拷贝到站点根目录，
 * 再通过 vite.config.ts 里 workbox 的 `importScripts: ['push-handler.js']`
 * 注入到 vite-plugin-pwa 生成的 sw.js 顶部。
 * （generateSW 策略不允许自带 SW 文件，importScripts 是官方留的口子。）
 *
 * 职责只有两件事，也只做这两件事：
 *   1. push               → 解析后端下发的 payload 并 showNotification
 *   2. notificationclick  → 关掉通知，聚焦（或打开）对镜并跳到对应地址
 *
 * 推送 payload（app/services/push.py 里两处调用点都按这个格式）：
 *   { title, body, url, tag, renotify }
 *
 * 刻意**不**做的事：不缓存任何请求、不碰 precache、不做后台同步。
 * 推送权是用户借给「他自己约的那个时间点」的，SW 里不该多出别的行为。
 */

/* eslint-env serviceworker */

var DUJING_DEFAULT_TITLE = '对镜';
var DUJING_DEFAULT_URL = '/debates';
var DUJING_DEFAULT_TAG = 'duijing-reminder';
var DUJING_ICON = '/icons/icon-192.png';

/** payload 解析：后端一定发 JSON，但解析失败也不能让事件挂掉 */
function readPushPayload(event) {
  if (!event.data) return {};
  try {
    var parsed = event.data.json();
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    try {
      return { body: event.data.text() };
    } catch (nested) {
      return {};
    }
  }
}

function pickString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

self.addEventListener('push', function (event) {
  var payload = readPushPayload(event);

  var title = pickString(payload.title, DUJING_DEFAULT_TITLE);
  var body = typeof payload.body === 'string' ? payload.body : '';
  var url = pickString(payload.url, DUJING_DEFAULT_URL);
  var tag = pickString(payload.tag, DUJING_DEFAULT_TAG);

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      // 同一场辩论的提醒用同一个 tag：重复触发时替换旧通知，不堆一屏
      tag: tag,
      // renotify 只有在 tag 非空时才合法；这里 tag 一定有值
      renotify: payload.renotify === true,
      data: { url: url },
      icon: DUJING_ICON,
      badge: DUJING_ICON,
    }),
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  var data = event.notification.data || {};
  var target = pickString(data.url, DUJING_DEFAULT_URL);

  event.waitUntil(openDuijing(target));
});

/** 已经开着对镜就聚焦并跳过去，否则开一个新窗口 */
function openDuijing(target) {
  var url = new URL(target, self.location.origin).href;

  return self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(function (windowClients) {
      var matched = null;
      for (var index = 0; index < windowClients.length; index += 1) {
        var client = windowClients[index];
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          matched = client;
          break;
        }
      }

      if (!matched) {
        if (self.clients.openWindow) return self.clients.openWindow(url);
        return undefined;
      }

      return matched.focus().then(function () {
        // 已经在这个地址上就不用再导航，免得打断用户正在做的事
        if (matched.url === url || !('navigate' in matched)) return undefined;
        return matched.navigate(url).catch(function () {
          return undefined;
        });
      });
    });
}
