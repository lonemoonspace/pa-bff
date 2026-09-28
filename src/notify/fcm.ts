// FCM HTTP v1 客户端：服务账号 JSON 解析、访问令牌签发（JWT RS256 + oauth2 交换）、
// 访问令牌缓存（isolate 内存，不落 D1）、单条消息发送与错误映射。
// 规格见 CONTRACT.md 第 6.4 节与 src/contract/push.ts。本模块不认识 D1 / 设备表，
// 「给哪些设备发」由 T5.2 的 notify/push.ts 负责，这里只管「怎么发一条」。
import { z } from "zod";
import type { PushData, PushOutcome } from "../contract/push";
import { PUSH_ROUTING } from "../contract/push";
import type { Env } from "../env";
import { registerTester } from "../secrets/testers";

/** 服务账号 JSON 里我们用到的字段；其余字段（token_uri 等）一律忽略。 */
export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

const ServiceAccountSchema = z
  .object({
    project_id: z.string().min(1),
    client_email: z.string().min(1),
    private_key: z.string().min(1),
    private_key_id: z.string().min(1).optional(),
  })
  .passthrough();

/** 解析 fcm_service_account 密钥的明文；不合法（非 JSON 或缺字段）时返回 null，不抛异常。 */
export function parseServiceAccount(plaintext: string): ServiceAccount | null {
  let json: unknown;
  try {
    json = JSON.parse(plaintext);
  } catch {
    return null;
  }
  const parsed = ServiceAccountSchema.safeParse(json);
  if (!parsed.success) return null;
  const sa: ServiceAccount = {
    project_id: parsed.data.project_id,
    client_email: parsed.data.client_email,
    private_key: parsed.data.private_key,
  };
  if (parsed.data.private_key_id !== undefined) sa.private_key_id = parsed.data.private_key_id;
  return sa;
}

export type FcmAuthErrorCode = "oauth_4xx" | "oauth_5xx" | "oauth_timeout" | "oauth_network" | "oauth_parse" | "bad_private_key";

/**
 * 取访问令牌失败。message 只含状态码与 Google 返回的 error 字段（如 invalid_grant），
 * 不含响应全文——避免把 oauth 错误响应体（可能夹带诊断信息）整段落进日志/lastTest。
 */
export class FcmAuthError extends Error {
  readonly code: FcmAuthErrorCode;

  constructor(code: FcmAuthErrorCode, message: string) {
    super(message);
    this.name = "FcmAuthError";
    this.code = code;
  }
}

export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const OAUTH_TIMEOUT_MS = 5000;
const DEFAULT_SEND_TIMEOUT_MS = 4000;

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromString(s: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(s));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 服务账号明文的指纹：作为缓存键，换了服务账号（明文不同）就不会误用旧令牌。 */
async function fingerprint(sa: ServiceAccount): Promise<string> {
  const canonical = JSON.stringify({
    project_id: sa.project_id,
    client_email: sa.client_email,
    private_key: sa.private_key,
    private_key_id: sa.private_key_id ?? null,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return toHex(new Uint8Array(digest));
}

/** PEM → PKCS8 DER → 不可导出的签名私钥。PEM 格式不对 / 不是合法 PKCS8 时抛 bad_private_key。 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  let der: Uint8Array;
  try {
    const binary = atob(base64);
    der = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) der[i] = binary.charCodeAt(i);
  } catch {
    throw new FcmAuthError("bad_private_key", "私钥格式无效（不是合法的 base64/PEM）");
  }
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new FcmAuthError("bad_private_key", "私钥格式无效（不是合法的 PKCS#8）");
  }
}

async function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: CryptoKey): Promise<string> {
  const signingInput = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

/** oauth2 错误响应体形如 { "error": "invalid_grant", "error_description": "..." }。 */
function extractOauthError(json: unknown): string | null {
  if (json && typeof json === "object" && "error" in json) {
    const value = (json as Record<string, unknown>).error;
    if (typeof value === "string") return value;
  }
  return null;
}

const OAuthTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive().optional(),
  })
  .passthrough();

function isAbortLikeError(err: unknown, combined: AbortSignal): boolean {
  if (combined.aborted) return true;
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

async function exchangeJwtForToken(
  jwt: string,
  signal: AbortSignal | undefined,
): Promise<{ accessToken: string; expiresIn: number }> {
  const signals: AbortSignal[] = [AbortSignal.timeout(OAUTH_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  const combined = AbortSignal.any(signals);

  const body = `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(jwt)}`;

  let response: Response;
  try {
    response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: combined,
    });
  } catch (err) {
    if (isAbortLikeError(err, combined)) {
      throw new FcmAuthError("oauth_timeout", "获取访问令牌超时");
    }
    throw new FcmAuthError("oauth_network", "获取访问令牌网络错误");
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    if (isAbortLikeError(err, combined)) {
      throw new FcmAuthError("oauth_timeout", "获取访问令牌超时（读取响应体途中）");
    }
    throw new FcmAuthError("oauth_network", "读取访问令牌响应失败");
  }

  let json: unknown = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const errField = extractOauthError(json);
    const code: FcmAuthErrorCode = response.status >= 400 && response.status < 500 ? "oauth_4xx" : "oauth_5xx";
    const message = `HTTP ${response.status}${errField ? ` ${errField}` : ""}`;
    throw new FcmAuthError(code, message);
  }

  const parsed = OAuthTokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new FcmAuthError("oauth_parse", "访问令牌响应解析失败");
  }
  return { accessToken: parsed.data.access_token, expiresIn: parsed.data.expires_in ?? 3600 };
}

interface CacheEntry {
  token: string;
  expiresAtMs: number;
  cryptoKey: CryptoKey;
}

// 模块级缓存：同一 isolate 内跨 notify 轮次复用访问令牌，不写 D1（第 6.4 节）。
const cache = new Map<string, CacheEntry>();

const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;

/**
 * 取访问令牌：命中缓存且未过期（含 5 分钟安全窗口）直接复用，否则签发新 JWT 交换。
 * now 由调用方注入，不读 Date.now()，便于测试与「至多一次」推理。
 */
export async function getAccessToken(sa: ServiceAccount, now: Date, signal?: AbortSignal): Promise<string> {
  const key = await fingerprint(sa);
  const nowMs = now.getTime();
  const cached = cache.get(key);
  if (cached && nowMs < cached.expiresAtMs - EXPIRY_SAFETY_MARGIN_MS) {
    return cached.token;
  }

  const cryptoKey = cached?.cryptoKey ?? (await importPrivateKey(sa.private_key));

  const iat = Math.floor(nowMs / 1000);
  const header: Record<string, unknown> = { alg: "RS256", typ: "JWT" };
  if (sa.private_key_id) header.kid = sa.private_key_id;
  const claims = {
    iss: sa.client_email,
    scope: FCM_SCOPE,
    aud: OAUTH_TOKEN_URL,
    iat,
    exp: iat + 3600,
  };
  const jwt = await signJwt(header, claims, cryptoKey);
  const { accessToken, expiresIn } = await exchangeJwtForToken(jwt, signal);

  cache.set(key, { token: accessToken, expiresAtMs: nowMs + expiresIn * 1000, cryptoKey });
  return accessToken;
}

/** FCM 返回 401 时调用：清掉全部缓存的访问令牌（不区分服务账号，简单可靠）。 */
export function invalidateAccessToken(): void {
  cache.clear();
}

/** 仅供测试使用：清空模块级缓存，避免用例之间互相影响。 */
export function resetFcmCacheForTest(): void {
  cache.clear();
}

export interface FcmMessage {
  message: {
    token: string;
    data: Record<string, string>;
    android: { priority: "HIGH"; ttl: string; collapse_key?: string };
  };
}

/** 按 PUSH_ROUTING 组装单条 FCM 消息；collapseKey 为 null 时不带 collapse_key 键。 */
export function buildFcmMessage(token: string, data: PushData): FcmMessage {
  const routing = PUSH_ROUTING[data.policy];
  const android: { priority: "HIGH"; ttl: string; collapse_key?: string } = {
    priority: "HIGH",
    ttl: routing.ttl,
  };
  if (routing.collapseKey !== null) android.collapse_key = routing.collapseKey;

  const messageData: Record<string, string> = {
    v: data.v,
    policy: data.policy,
    channelId: data.channelId,
    deepLink: data.deepLink,
    notificationKey: data.notificationKey,
    title: data.title,
    body: data.body,
    sentAt: data.sentAt,
  };

  return { message: { token, data: messageData, android } };
}

const FcmErrorBodySchema = z
  .object({
    error: z
      .object({
        status: z.string().optional(),
        details: z
          .array(z.object({ errorCode: z.string().optional() }).passthrough())
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function fcmErrorCode(json: unknown): string | undefined {
  const parsed = FcmErrorBodySchema.safeParse(json);
  if (!parsed.success) return undefined;
  const details = parsed.data.error?.details ?? [];
  for (const d of details) {
    if (d.errorCode) return d.errorCode;
  }
  return undefined;
}

export interface SendFcmOptions {
  timeoutMs?: number;
}

/**
 * 发一条 FCM 消息，按 CONTRACT 第 6.4 节的映射表返回 outcome；永不抛异常。
 * signal 由调度器/请求处理器传入（tick 超时、请求中止等），与内部超时信号合并。
 */
export async function sendFcm(
  accessToken: string,
  projectId: string,
  message: FcmMessage,
  signal?: AbortSignal,
  options: SendFcmOptions = {},
): Promise<PushOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const combined = AbortSignal.any(signals);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
      signal: combined,
    });
  } catch (err) {
    if (signal?.aborted) return "aborted";
    if (isAbortLikeError(err, combined)) return "timeout";
    return "network";
  }

  if (response.ok) {
    await response.body?.cancel();
    return "ok";
  }

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  if (response.status === 404) return "unregistered";
  if (response.status === 400) {
    return fcmErrorCode(json) === "UNREGISTERED" ? "unregistered" : "invalid_argument";
  }
  if (response.status === 401) return "auth_error";
  if (response.status === 403) return "sender_mismatch";
  if (response.status === 429) return "rate_limited";
  return response.status >= 500 ? "upstream_5xx" : "upstream_4xx";
}

// registerTester 幂等覆盖，重复 import 不会有问题（见 secrets/testers.ts 注释）。
// 只验证「能不能取到访问令牌」，不发任何 FCM 消息（第 3 节 PUT /v1/secrets/:name）。
registerTester("fcm_service_account", async (_env: Env, plaintext: string) => {
  const sa = parseServiceAccount(plaintext);
  if (!sa) {
    return { ok: false, message: "服务账号 JSON 缺少 project_id / client_email / private_key" };
  }
  try {
    await getAccessToken(sa, new Date());
    return { ok: true, message: `已取得 FCM 访问令牌（项目 ${sa.project_id}）` };
  } catch (err) {
    if (err instanceof FcmAuthError) {
      return { ok: false, message: `无法取得访问令牌：${err.code} ${err.message}` };
    }
    throw err;
  }
});
