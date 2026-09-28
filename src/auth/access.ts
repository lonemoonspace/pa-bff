// Cloudflare Access 的 JWT 校验。契约见 CONTRACT.md 第 2 节「管理界面」。
// 只在配置了 ACCESS_TEAM_DOMAIN 与 ACCESS_AUD 时启用；不校验 CF_Authorization cookie，
// 只认请求头 Cf-Access-Jwt-Assertion（cookie 可能被跨站请求带上，见 CSRF 说明）。
import type { Env } from "../env";

export type AccessErrorCode = "access_denied" | "access_unavailable";

/** 校验失败的统一异常：调用方按 code 决定 401 还是 503（页面则一律 403）。 */
export class AccessError extends Error {
  readonly code: AccessErrorCode;
  constructor(code: AccessErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** 两个变量都非空才算开启管理界面。 */
export function adminEnabled(env: Env): boolean {
  return typeof env.ACCESS_TEAM_DOMAIN === "string" && env.ACCESS_TEAM_DOMAIN.length > 0 && typeof env.ACCESS_AUD === "string" && env.ACCESS_AUD.length > 0;
}

const JWKS_TTL_MS = 10 * 60 * 1000;
// 允许的时钟误差：exp / nbf 判断都放宽 60 秒。
const CLOCK_SKEW_SEC = 60;

interface JwksCacheEntry {
  domain: string;
  fetchedAt: number;
  keys: Map<string, CryptoKey>;
}

// isolate 内模块级缓存：同一 isolate 内多次请求共享，避免每次请求都打 JWKS 端点。
let cache: JwksCacheEntry | null = null;

/** 仅供测试用：清空 JWKS 缓存，避免用例互相影响。 */
export function resetAccessCacheForTest(): void {
  cache = null;
}

function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = normalized.length % 4;
  const padded = padLength === 0 ? normalized : normalized + "=".repeat(4 - padLength);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  const bytes = base64UrlToBytes(segment);
  const text = new TextDecoder().decode(bytes);
  const value = JSON.parse(text);
  if (typeof value !== "object" || value === null) {
    throw new Error("JWT 分段不是对象");
  }
  return value as Record<string, unknown>;
}

async function fetchJwks(domain: string): Promise<Map<string, CryptoKey>> {
  let res: Response;
  try {
    res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  } catch {
    throw new AccessError("access_unavailable", "无法获取 Access 证书");
  }
  if (!res.ok) {
    throw new AccessError("access_unavailable", "无法获取 Access 证书");
  }
  let body: { keys?: unknown };
  try {
    body = await res.json();
  } catch {
    throw new AccessError("access_unavailable", "无法获取 Access 证书");
  }

  const keys = new Map<string, CryptoKey>();
  const rawKeys = Array.isArray(body.keys) ? body.keys : [];
  for (const raw of rawKeys) {
    if (typeof raw !== "object" || raw === null) continue;
    const jwk = raw as Record<string, unknown>;
    const kid = typeof jwk.kid === "string" ? jwk.kid : null;
    if (!kid) continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk as unknown as JsonWebKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(kid, key);
    } catch {
      // 单个 key 格式有问题不应拖垮整批（例如未来加入非 RSA 密钥）。
    }
  }
  return keys;
}

async function getKeyForKid(domain: string, kid: string, nowMs: number): Promise<CryptoKey> {
  if (!cache || cache.domain !== domain || nowMs - cache.fetchedAt > JWKS_TTL_MS) {
    cache = { domain, fetchedAt: nowMs, keys: await fetchJwks(domain) };
  }
  let key = cache.keys.get(kid);
  if (!key) {
    // 未知 kid：应对密钥轮换，立即重取一次（仅一次，避免被恶意 kid 触发无限请求）。
    cache = { domain, fetchedAt: nowMs, keys: await fetchJwks(domain) };
    key = cache.keys.get(kid);
  }
  if (!key) {
    throw new AccessError("access_denied", "未知的签名密钥");
  }
  return key;
}

/**
 * 校验 Cf-Access-Jwt-Assertion 的签名、iss、aud、exp/nbf、email。
 * 任何一项不满足都抛 AccessError；错误消息里不回显 JWT 内容。
 */
export async function verifyAccessJwt(env: Env, token: string, now: Date): Promise<{ email: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AccessError("access_denied", "凭证格式不正确");
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJsonSegment(headerB64);
    payload = decodeJsonSegment(payloadB64);
  } catch {
    throw new AccessError("access_denied", "凭证格式不正确");
  }

  if (header.alg !== "RS256") {
    throw new AccessError("access_denied", "不支持的签名算法");
  }
  const kid = typeof header.kid === "string" ? header.kid : null;
  if (!kid) {
    throw new AccessError("access_denied", "缺少签名密钥标识");
  }

  const domain = env.ACCESS_TEAM_DOMAIN;
  if (!domain) {
    throw new AccessError("access_unavailable", "未配置 Access 域名");
  }

  const nowMs = now.getTime();
  const key = await getKeyForKid(domain, kid, nowMs);

  let signatureValid: boolean;
  try {
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlToBytes(sigB64);
    signatureValid = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, data);
  } catch {
    throw new AccessError("access_denied", "签名校验失败");
  }
  if (!signatureValid) {
    throw new AccessError("access_denied", "签名校验失败");
  }

  const iss = typeof payload.iss === "string" ? payload.iss : null;
  if (iss !== `https://${domain}`) {
    throw new AccessError("access_denied", "签发者不匹配");
  }

  const aud = payload.aud;
  const audList = Array.isArray(aud) ? aud : typeof aud === "string" ? [aud] : [];
  if (!env.ACCESS_AUD || !audList.includes(env.ACCESS_AUD)) {
    throw new AccessError("access_denied", "受众不匹配");
  }

  const exp = typeof payload.exp === "number" ? payload.exp : null;
  if (exp === null || nowMs > (exp + CLOCK_SKEW_SEC) * 1000) {
    throw new AccessError("access_denied", "凭证已过期");
  }
  const nbf = typeof payload.nbf === "number" ? payload.nbf : null;
  if (nbf !== null && nowMs < (nbf - CLOCK_SKEW_SEC) * 1000) {
    throw new AccessError("access_denied", "凭证尚未生效");
  }

  const email = typeof payload.email === "string" && payload.email.length > 0 ? payload.email : null;
  if (!email) {
    throw new AccessError("access_denied", "缺少邮箱");
  }

  return { email };
}
