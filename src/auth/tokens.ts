// 设备令牌 / 认领码 / 配对码共用的安全小工具：生成、哈希、常数时间比较。
// 只用 Web 标准 API（crypto.subtle、crypto.getRandomValues），不引入依赖。

const DEVICE_TOKEN_PREFIX = "pa_";
const DEVICE_TOKEN_RANDOM_BYTES = 32;
const PAIR_CODE_LENGTH = 8;
// Crockford base32：排除易混淆的 I L O U，人工输入配对码时不容易读错。
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 生成新设备令牌："pa_" + 32 字节随机数的 base64url。明文只在生成时短暂存在，之后只存哈希。 */
export function generateDeviceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(DEVICE_TOKEN_RANDOM_BYTES));
  return DEVICE_TOKEN_PREFIX + bytesToBase64Url(bytes);
}

/** sha256(input) 的 hex 摘要。令牌 / 认领码 / 配对码一律只存这个，不存明文。 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * 常数时间比较两个字符串：各自先 sha256（摘要长度恒为 32 字节，与输入长度无关），
 * 再用 crypto.subtle.timingSafeEqual 比较摘要。避免直接比较明文字符串时，因为
 * 提前在第一个不同字符处返回而产生的时序侧信道（能被用来逐字符猜出认领码）。
 */
export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(a)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

/** 生成 8 位 Crockford base32 配对码，例如 "7K3PXQ2M"。 */
export function generatePairCode(): string {
  // 5 位一个字符，8 个字符正好需要 40 位 = 5 字节随机数，不用做位对齐之外的额外计算。
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = PAIR_CODE_LENGTH - 1; i >= 0; i--) {
    const shift = BigInt(i * 5);
    const index = Number((bits >> shift) & 0x1fn);
    out += CROCKFORD_ALPHABET[index];
  }
  return out;
}
