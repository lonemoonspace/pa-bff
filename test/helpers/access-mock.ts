// T7.1 测试专用：现场生成 RSA 测试密钥对（不提交任何真实凭据），签发 Cloudflare Access
// 风格的 JWT，并按 URL 分派 fetch 到假的 JWKS 端点。供 test/auth/access.test.ts、
// test/api/admin.test.ts 及后续 P7 任务卡共用。
import { vi } from "vitest";

export interface AccessTestKey {
  kid: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

/** 现场生成一份 RSA-2048 测试密钥对，模拟 Access 的一个 JWKS 条目。 */
export async function makeAccessTestKey(kid: string): Promise<AccessTestKey> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return { kid, publicKey: keyPair.publicKey, privateKey: keyPair.privateKey };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * 用测试私钥签一个 RS256 JWT。header 默认 { alg: "RS256", kid }，可传 headerOverrides
 * 覆盖（例如伪造 alg: "none" 或缺 kid 的场景）。
 */
export async function signAccessJwt(
  payload: Record<string, unknown>,
  key: { privateKey: CryptoKey; kid: string },
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: key.kid, ...headerOverrides };
  const headerB64 = base64UrlEncodeJson(header);
  const payloadB64 = base64UrlEncodeJson(payload);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key.privateKey, data));
  return `${headerB64}.${payloadB64}.${base64UrlEncode(signature)}`;
}

/** 未签名（或用另一把私钥签名）时也可以直接拼三段，供伪造篡改场景使用。 */
export function joinJwtParts(headerB64: string, payloadB64: string, sigB64: string): string {
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

async function exportJwk(publicKey: CryptoKey, kid: string): Promise<Record<string, unknown>> {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  return { ...jwk, kid, alg: "RS256", use: "sig" };
}

export interface MockJwksHandle {
  calls: string[];
}

/**
 * 拦截对 https://<domain>/cdn-cgi/access/certs 的请求，返回 keys 对应的 JWKS。
 * calls 记录每次实际发出的请求 URL，供断言「只取 1 次」之类的用例。
 */
export function mockAccessJwks(domain: string, keys: AccessTestKey[]): MockJwksHandle {
  const calls: string[] = [];
  const url = `https://${domain}/cdn-cgi/access/certs`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const reqUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (reqUrl === url) {
      calls.push(reqUrl);
      const jwks = { keys: await Promise.all(keys.map((k) => exportJwk(k.publicKey, k.kid))) };
      return new Response(JSON.stringify(jwks), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`mockAccessJwks: 未处理的 URL（测试忘了 mock？）：${reqUrl}`);
  });
  return { calls };
}

/** 让 JWKS 端点直接失败（网络错误），用于 access_unavailable 场景。 */
export function mockAccessJwksFailure(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("network down");
  });
}
