// P5 测试专用：生成一次性测试服务账号（现场用 WebCrypto 生成 RSA 密钥对，不提交任何
// 真实凭据），以及按 URL 分派的假 Google 端点（oauth2 换令牌 / FCM 发送）。
// 供 T5.1（notify/fcm）、T5.2（notify/push）、T5.4（jobs/notify）、T5.5（api/push-test）共用。
import { vi } from "vitest";
import type { ServiceAccount } from "../../src/notify/fcm";

export interface TestServiceAccount {
  /** JSON 字符串，可直接喂给 putSecret / parseServiceAccount。 */
  json: string;
  sa: ServiceAccount;
  /** 与 sa.private_key 配对的公钥，用来验签 JWT。 */
  publicKey: CryptoKey;
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

/** 现场生成一份测试用服务账号（RSA-2048，RS256）。每次调用都是新的随机密钥对。 */
export async function makeTestServiceAccount(opts: { privateKeyId?: string } = {}): Promise<TestServiceAccount> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer;
  const sa: ServiceAccount = {
    project_id: "test-project",
    client_email: "fcm-test@test-project.iam.gserviceaccount.com",
    private_key: pemFromPkcs8(pkcs8),
  };
  if (opts.privateKeyId) sa.private_key_id = opts.privateKeyId;

  return { json: JSON.stringify(sa), sa, publicKey: keyPair.publicKey };
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  bodyText: string;
}

export type MockResponder = (req: RecordedRequest) => Response | Promise<Response>;

export interface MockGoogleOptions {
  /** 未提供时默认返回 { access_token: "test-access-token", expires_in: 3600 }。 */
  oauth?: MockResponder;
  /** 未提供时默认返回 FCM 成功响应。 */
  fcm?: MockResponder;
}

export interface MockGoogleHandle {
  oauthCalls: RecordedRequest[];
  fcmCalls: RecordedRequest[];
}

function defaultOauthResponse(): Response {
  return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function defaultFcmResponse(): Response {
  return new Response(JSON.stringify({ name: "projects/test-project/messages/0" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * 用 vi.spyOn(globalThis, "fetch") 拦截对 oauth2.googleapis.com 与 fcm.googleapis.com
 * 的请求，按 URL 分派给 opts.oauth / opts.fcm（缺省给出成功响应）。请求会被记录到返回值
 * 里，供断言 URL / 请求头 / 请求体。其余 URL 会抛错（提醒用例漏 mock，而不是悄悄联网）。
 */
export function mockGoogle(opts: MockGoogleOptions = {}): MockGoogleHandle {
  const oauthCalls: RecordedRequest[] = [];
  const fcmCalls: RecordedRequest[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const req: RecordedRequest = { url, method, headers, bodyText };

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      oauthCalls.push(req);
      return opts.oauth ? opts.oauth(req) : defaultOauthResponse();
    }
    if (url.startsWith("https://fcm.googleapis.com/")) {
      fcmCalls.push(req);
      return opts.fcm ? opts.fcm(req) : defaultFcmResponse();
    }
    throw new Error(`mockGoogle: 未处理的 URL（测试忘了 mock？）：${method} ${url}`);
  });

  return { oauthCalls, fcmCalls };
}
