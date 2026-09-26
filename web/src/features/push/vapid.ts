/**
 * 对镜 · VAPID 密钥编解码
 *
 * `pushManager.subscribe()` 的 `applicationServerKey` 要的是**二进制**公钥，
 * 而服务端（app/services/push.py 的 `public_key()`）给的是 base64url 文本。
 * 这两者之间的转换是整个 Web Push 接入里最容易写错的一步：
 *
 *   · base64url 用 `-` `_` 代替 base64 的 `+` `/`，且**去掉了末尾的 `=` 填充**；
 *     直接丢给 `atob()` 会抛 InvalidCharacterError。
 *   · `atob()` 返回的是「一个字符一个字节」的二进制字符串，
 *     必须逐字节取 `charCodeAt`，写成 `new Uint8Array(atob(key))` 是错的
 *     （那会把字符串按 UTF-16 编码，密钥直接损坏，订阅能成功但推送全部失败）。
 *
 * 这两个函数是互逆的，放在一起方便对照检查。
 */

/**
 * base64url 字符串 → Uint8Array（用于 `applicationServerKey`）。
 *
 * 注意返回类型交给 TS 推导而不是手写 `Uint8Array`：
 * TS 5.7 起 `Uint8Array` 带了 `ArrayBufferLike` 泛型参数，手写成无参数的
 * `Uint8Array` 会变成 `Uint8Array<ArrayBufferLike>`，无法赋给 DOM 的
 * `BufferSource`（= `ArrayBufferView<ArrayBuffer> | ArrayBuffer`）。
 * 推导出来的 `Uint8Array<ArrayBuffer>` 才是各版本都安全的。
 *
 * @param base64Url 服务端下发的 VAPID 公钥，例如 "BEl62iUYgUivxIkv69yViEuiBIa-..."
 */
export function urlBase64ToUint8Array(base64Url: string) {
  // 1. 补回被 base64url 省略的 `=` 填充（长度必须是 4 的倍数，否则 atob 报错）
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  // 2. base64url → 标准 base64
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');

  // 3. atob 解码成「每字符一字节」的二进制字符串
  const binary = atob(base64);

  // 4. 逐字节搬运；**不能**用 new Uint8Array(binary)
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Uint8Array / ArrayBuffer → base64url 字符串（无 `=` 填充）。
 * 用于把订阅里的 p256dh / auth 回传给服务端，与上面的函数互逆。
 */
export function bufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 比较浏览器已有订阅用的公钥和当前服务端公钥是不是同一把 */
export function isSameApplicationServerKey(
  existing: ArrayBuffer | null | undefined,
  expected: Uint8Array,
): boolean {
  if (!existing) return false;
  const current = new Uint8Array(existing);
  if (current.length !== expected.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== expected[index]) return false;
  }
  return true;
}
