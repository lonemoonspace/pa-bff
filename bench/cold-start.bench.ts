// FCM 访问令牌与 Cloudflare Access JWT 的「冷启动」基准：importKey + 一次签名/验签。
// 两处都调用 src 里真实导出的函数，只把网络请求（oauth2 换令牌 / 取 JWKS）换成 mock-fetch，
// 并在每次迭代前清空模块级缓存（resetFcmCacheForTest / resetAccessCacheForTest，均为源码
// 里明确「仅供测试使用」的导出）强制走冷路径——否则第二次调用会命中缓存，测出来的就不是
//「冷启动」而是「缓存命中」的开销。
import { getAccessToken, resetFcmCacheForTest } from "../src/notify/fcm";
import { resetAccessCacheForTest, verifyAccessJwt } from "../src/auth/access";
import type { Env } from "../src/env";
import { withFetch } from "./mock-fetch";
import { bench, type BenchResult } from "./stats";

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlFromString(s: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(s));
}

function pemFromPkcs8(der: ArrayBuffer): string {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) lines.push(base64.slice(i, i + 64));
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

async function benchFcmColdStart(): Promise<BenchResult> {
  // 密钥对只生成一次（不计时——生产环境里私钥是配置好的常量，不会每次请求现场生成）。
  const keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer;
  const sa = {
    project_id: "bench-project",
    client_email: "fcm-bench@bench-project.iam.gserviceaccount.com",
    private_key: pemFromPkcs8(pkcs8),
  };

  return bench(
    "FCM 冷启动（importKey PKCS8 + 一次 RS256 签名）",
    { iterations: 300, warmup: 5 },
    () => resetFcmCacheForTest(),
    () =>
      withFetch(
        () => ({ body: { access_token: "bench-token", expires_in: 3600 } }),
        () => getAccessToken(sa, new Date()),
      ),
  );
}

async function benchAccessColdStart(): Promise<BenchResult> {
  const domain = "bench-team.cloudflareaccess.com";
  const aud = "bench-aud";
  const kid = "bench-kid";
  const keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  const jwks = { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] };

  const now = new Date();
  const header = { alg: "RS256", typ: "JWT", kid };
  const payload = {
    iss: `https://${domain}`,
    aud,
    email: "bench@example.com",
    exp: Math.floor(now.getTime() / 1000) + 3600,
    nbf: Math.floor(now.getTime() / 1000) - 60,
  };
  const signingInput = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  const token = `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;

  const env = { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: aud } as unknown as Env;

  return bench(
    "Access JWT 冷启动（importKey JWK + 一次验签）",
    { iterations: 300, warmup: 5 },
    () => resetAccessCacheForTest(),
    () =>
      withFetch(
        () => ({ body: jwks }),
        () => verifyAccessJwt(env, token, now),
      ),
  );
}

export async function runColdStartBenches(): Promise<BenchResult[]> {
  return [await benchFcmColdStart(), await benchAccessColdStart()];
}
