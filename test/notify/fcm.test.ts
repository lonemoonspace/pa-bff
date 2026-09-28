// notify/fcm.ts 的单测：JWT 构造与签名、访问令牌缓存与错误映射、buildFcmMessage、
// sendFcm 的错误映射表。不访问真实网络：oauth2/fcm 用 test/helpers/fcm-mock.ts 按 URL
// 分派的假实现（vi.spyOn(globalThis, "fetch")，项目里 P5 一律用这个而不是 fetchMock）。
import { afterEach, describe, expect, it, vi } from "vitest";
import fcmErrorUnregistered from "../fixtures/fcm/send-error-400-unregistered.json";
import fcmErrorInvalidArgument from "../fixtures/fcm/send-error-400-invalid-argument.json";
import fcmErrorSenderMismatch from "../fixtures/fcm/send-error-403-sender-mismatch.json";
import fcmErrorNotFound from "../fixtures/fcm/send-error-404-not-found.json";
import fcmErrorUnauthenticated from "../fixtures/fcm/send-error-401-unauthenticated.json";
import fcmErrorRateLimited from "../fixtures/fcm/send-error-429-rate-limited.json";
import fcmErrorUnavailable from "../fixtures/fcm/send-error-503-unavailable.json";
import oauthError400 from "../fixtures/fcm/oauth-error-400.json";
import oauthError500 from "../fixtures/fcm/oauth-error-500.json";
import { makeTestServiceAccount, mockGoogle } from "../helpers/fcm-mock";
import {
  buildFcmMessage,
  FcmAuthError,
  getAccessToken,
  invalidateAccessToken,
  OAUTH_TOKEN_URL,
  parseServiceAccount,
  resetFcmCacheForTest,
  sendFcm,
} from "../../src/notify/fcm";
import type { PushData } from "../../src/contract/push";

function b64urlDecode(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(segment.length + ((4 - (segment.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64urlDecodeJson(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(segment)));
}

afterEach(() => {
  vi.restoreAllMocks();
  resetFcmCacheForTest();
});

describe("parseServiceAccount", () => {
  it("完整 JSON → 解析成功，忽略其余字段（token_uri 等）", () => {
    const sa = parseServiceAccount(
      JSON.stringify({
        project_id: "proj-1",
        client_email: "a@proj-1.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
        private_key_id: "key-1",
        token_uri: "https://example.test/should-be-ignored",
      }),
    );
    expect(sa).toEqual({
      project_id: "proj-1",
      client_email: "a@proj-1.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      private_key_id: "key-1",
    });
  });

  it("缺 private_key_id 时该字段不存在于结果里", () => {
    const sa = parseServiceAccount(
      JSON.stringify({ project_id: "p", client_email: "e@p.iam.gserviceaccount.com", private_key: "k" }),
    );
    expect(sa).not.toBeNull();
    expect(sa && "private_key_id" in sa).toBe(false);
  });

  it("非 JSON → null", () => {
    expect(parseServiceAccount("not-json")).toBeNull();
  });

  it("缺 project_id / client_email / private_key 任一 → null", () => {
    expect(parseServiceAccount(JSON.stringify({ client_email: "a@b", private_key: "k" }))).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ project_id: "p", private_key: "k" }))).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ project_id: "p", client_email: "a@b" }))).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ project_id: "", client_email: "a@b", private_key: "k" }))).toBeNull();
  });
});

describe("getAccessToken：JWT 构造与签名", () => {
  it("头与声明逐字段相等，段内无 padding 字符，签名用公钥验证通过（无 kid）", async () => {
    const { sa, publicKey } = await makeTestServiceAccount();
    const handle = mockGoogle();
    const now = new Date("2026-09-23T09:00:00.000Z");

    const token = await getAccessToken(sa, now);
    expect(token).toBe("test-access-token");

    const call = handle.oauthCalls[0];
    if (!call) throw new Error("expected oauth call");
    const params = new URLSearchParams(call.bodyText);
    const jwt = params.get("assertion");
    if (!jwt) throw new Error("expected assertion in body");

    for (const segment of jwt.split(".")) {
      expect(segment).not.toMatch(/[=+/]/);
    }

    const [headerSeg, claimsSeg, sigSeg] = jwt.split(".");
    if (!headerSeg || !claimsSeg || !sigSeg) throw new Error("expected 3-segment JWT");

    expect(b64urlDecodeJson(headerSeg)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(b64urlDecodeJson(claimsSeg)).toEqual({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: OAUTH_TOKEN_URL,
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + 3600,
    });

    const signature = b64urlDecode(sigSeg);
    const signingInput = new TextEncoder().encode(`${headerSeg}.${claimsSeg}`);
    const valid = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, publicKey, signature, signingInput);
    expect(valid).toBe(true);
  });

  it("有 private_key_id 时头里带 kid", async () => {
    const { sa } = await makeTestServiceAccount({ privateKeyId: "kid-123" });
    const handle = mockGoogle();
    await getAccessToken(sa, new Date("2026-09-23T09:00:00.000Z"));

    const call = handle.oauthCalls[0];
    if (!call) throw new Error("expected oauth call");
    const jwt = new URLSearchParams(call.bodyText).get("assertion");
    if (!jwt) throw new Error("expected assertion");
    const headerSeg = jwt.split(".")[0];
    if (!headerSeg) throw new Error("expected header segment");
    expect(b64urlDecodeJson(headerSeg)).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-123" });
  });

  it("oauth 请求的 URL / 方法 / Content-Type / 表单字段逐字相等", async () => {
    const { sa } = await makeTestServiceAccount();
    const handle = mockGoogle();
    await getAccessToken(sa, new Date("2026-09-23T09:00:00.000Z"));

    const call = handle.oauthCalls[0];
    if (!call) throw new Error("expected oauth call");
    expect(call.url).toBe("https://oauth2.googleapis.com/token");
    expect(call.method).toBe("POST");
    expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(call.bodyText);
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(params.get("assertion")).toBeTruthy();
    expect([...params.keys()].sort()).toEqual(["assertion", "grant_type"]);
  });
});

describe("getAccessToken：缓存", () => {
  it("同一 now 连取两次只发 1 次 oauth 请求", async () => {
    const { sa } = await makeTestServiceAccount();
    const handle = mockGoogle();
    const now = new Date("2026-09-23T09:00:00.000Z");

    const t1 = await getAccessToken(sa, now);
    const t2 = await getAccessToken(sa, now);
    expect(t1).toBe(t2);
    expect(handle.oauthCalls).toHaveLength(1);
  });

  it("expires_in: 3600 时 now+54 分钟复用、now+55 分钟重取", async () => {
    const { sa } = await makeTestServiceAccount();
    const handle = mockGoogle();
    const t0 = new Date("2026-09-23T09:00:00.000Z");
    await getAccessToken(sa, t0);
    expect(handle.oauthCalls).toHaveLength(1);

    await getAccessToken(sa, new Date(t0.getTime() + 54 * 60 * 1000));
    expect(handle.oauthCalls).toHaveLength(1);

    await getAccessToken(sa, new Date(t0.getTime() + 55 * 60 * 1000));
    expect(handle.oauthCalls).toHaveLength(2);
  });

  it("服务账号换了（明文不同）重取", async () => {
    const a = await makeTestServiceAccount();
    const b = await makeTestServiceAccount();
    const handle = mockGoogle();
    const now = new Date("2026-09-23T09:00:00.000Z");

    await getAccessToken(a.sa, now);
    await getAccessToken(b.sa, now);
    expect(handle.oauthCalls).toHaveLength(2);
  });

  it("invalidateAccessToken() 后重取", async () => {
    const { sa } = await makeTestServiceAccount();
    const handle = mockGoogle();
    const now = new Date("2026-09-23T09:00:00.000Z");

    await getAccessToken(sa, now);
    invalidateAccessToken();
    await getAccessToken(sa, now);
    expect(handle.oauthCalls).toHaveLength(2);
  });

  it("缺 expires_in 时按 3600 秒处理", async () => {
    const { sa } = await makeTestServiceAccount();
    mockGoogle({
      oauth: () =>
        new Response(JSON.stringify({ access_token: "no-expiry-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const t0 = new Date("2026-09-23T09:00:00.000Z");
    await getAccessToken(sa, t0);

    const handle2 = mockGoogle();
    await getAccessToken(sa, new Date(t0.getTime() + 54 * 60 * 1000));
    expect(handle2.oauthCalls).toHaveLength(0);
    await getAccessToken(sa, new Date(t0.getTime() + 55 * 60 * 1000));
    expect(handle2.oauthCalls).toHaveLength(1);
  });
});

describe("getAccessToken：错误映射", () => {
  it("oauth 400 invalid_grant → FcmAuthError(oauth_4xx)，消息不含 JWT", async () => {
    const { sa } = await makeTestServiceAccount();
    mockGoogle({
      oauth: () =>
        new Response(JSON.stringify(oauthError400), { status: 400, headers: { "content-type": "application/json" } }),
    });

    let caught: unknown;
    try {
      await getAccessToken(sa, new Date());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FcmAuthError);
    const err = caught as FcmAuthError;
    expect(err.code).toBe("oauth_4xx");
    expect(err.message).toContain("invalid_grant");
    expect(err.message).not.toContain(".");
  });

  it("oauth 500 → FcmAuthError(oauth_5xx)", async () => {
    const { sa } = await makeTestServiceAccount();
    mockGoogle({
      oauth: () =>
        new Response(JSON.stringify(oauthError500), { status: 500, headers: { "content-type": "application/json" } }),
    });

    await expect(getAccessToken(sa, new Date())).rejects.toMatchObject({ code: "oauth_5xx" });
  });

  it("oauth 超时 → FcmAuthError(oauth_timeout)", async () => {
    const { sa } = await makeTestServiceAccount();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject((signal as AbortSignal).reason));
      });
    });

    await expect(getAccessToken(sa, new Date())).rejects.toMatchObject({ code: "oauth_timeout" });
  }, 10000);

  it("oauth 网络错误 → FcmAuthError(oauth_network)", async () => {
    const { sa } = await makeTestServiceAccount();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));

    await expect(getAccessToken(sa, new Date())).rejects.toMatchObject({ code: "oauth_network" });
  });

  it("oauth 响应非 JSON → FcmAuthError(oauth_parse)", async () => {
    const { sa } = await makeTestServiceAccount();
    mockGoogle({ oauth: () => new Response("not json", { status: 200 }) });

    await expect(getAccessToken(sa, new Date())).rejects.toMatchObject({ code: "oauth_parse" });
  });

  it("私钥不是合法 PKCS#8（非法 base64）→ FcmAuthError(bad_private_key)，不发请求", async () => {
    const sa = { project_id: "p", client_email: "e@p.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\n@@@not-base64@@@\n-----END PRIVATE KEY-----\n" };
    const handle = mockGoogle();

    await expect(getAccessToken(sa, new Date())).rejects.toMatchObject({ code: "bad_private_key" });
    expect(handle.oauthCalls).toHaveLength(0);
  });

  it("私钥是合法 base64 但不是合法 PKCS#8 结构 → FcmAuthError(bad_private_key)", async () => {
    const garbage = btoa("this is not a real pkcs8 der document, just plain bytes padded out");
    const sa = { project_id: "p", client_email: "e@p.iam.gserviceaccount.com", private_key: `-----BEGIN PRIVATE KEY-----\n${garbage}\n-----END PRIVATE KEY-----\n` };

    await expect(getAccessToken(sa, new Date())).rejects.toMatchObject({ code: "bad_private_key" });
  });

  it("错误消息不含 PRIVATE KEY 字样、不含完整 JWT", async () => {
    const { sa } = await makeTestServiceAccount();
    mockGoogle({
      oauth: () =>
        new Response(JSON.stringify(oauthError400), { status: 400, headers: { "content-type": "application/json" } }),
    });
    try {
      await getAccessToken(sa, new Date());
      throw new Error("expected rejection");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain("PRIVATE KEY");
      expect(message).not.toContain(sa.private_key);
    }
  });
});

describe("buildFcmMessage", () => {
  const base: Omit<PushData, "policy" | "channelId" | "deepLink"> = {
    v: "1",
    notificationKey: "key-1",
    title: "标题",
    body: "正文",
    sentAt: "2026-09-23T07:00:00Z",
  };

  const cases: Array<{ policy: PushData["policy"]; channelId: PushData["channelId"]; deepLink: PushData["deepLink"] }> = [
    { policy: "commute_disruption", channelId: "commute_disruption", deepLink: "personalassistant://home" },
    { policy: "morning_brief", channelId: "morning_brief", deepLink: "personalassistant://home" },
    { policy: "football", channelId: "football_match", deepLink: "personalassistant://football" },
    { policy: "ticket", channelId: "ticket_expiry", deepLink: "personalassistant://home" },
    { policy: "test", channelId: "morning_brief", deepLink: "personalassistant://home" },
  ];

  it.each(cases)("$policy：与 PUSH_ROUTING 表逐字段相等", ({ policy, channelId, deepLink }) => {
    const data: PushData = { ...base, policy, channelId, deepLink };
    const message = buildFcmMessage("device-token-1", data);

    expect(message.message.token).toBe("device-token-1");
    expect(message.message.data).toEqual({
      v: "1",
      policy,
      channelId,
      deepLink,
      notificationKey: "key-1",
      title: "标题",
      body: "正文",
      sentAt: "2026-09-23T07:00:00Z",
    });
    expect(message.message.android.priority).toBe("HIGH");
  });

  it("commute_disruption / morning_brief 带 collapse_key，football / ticket / test 不带该键", () => {
    const withCollapse: PushData["policy"][] = ["commute_disruption", "morning_brief"];
    const withoutCollapse: PushData["policy"][] = ["football", "ticket", "test"];

    for (const policy of withCollapse) {
      const c = cases.find((c) => c.policy === policy);
      if (!c) throw new Error("missing case");
      const message = buildFcmMessage("t", { ...base, ...c });
      expect(message.message.android.collapse_key).toBeTypeOf("string");
    }
    for (const policy of withoutCollapse) {
      const c = cases.find((c) => c.policy === policy);
      if (!c) throw new Error("missing case");
      const message = buildFcmMessage("t", { ...base, ...c });
      expect("collapse_key" in message.message.android).toBe(false);
    }
  });

  it("ttl 与 PUSH_ROUTING 表一致", () => {
    const commute = buildFcmMessage("t", { ...base, policy: "commute_disruption", channelId: "commute_disruption", deepLink: "personalassistant://home" });
    expect(commute.message.android.ttl).toBe("900s");
    const morning = buildFcmMessage("t", { ...base, policy: "morning_brief", channelId: "morning_brief", deepLink: "personalassistant://home" });
    expect(morning.message.android.ttl).toBe("3600s");
    const football = buildFcmMessage("t", { ...base, policy: "football", channelId: "football_match", deepLink: "personalassistant://football" });
    expect(football.message.android.ttl).toBe("3600s");
    const ticket = buildFcmMessage("t", { ...base, policy: "ticket", channelId: "ticket_expiry", deepLink: "personalassistant://home" });
    expect(ticket.message.android.ttl).toBe("43200s");
    const test = buildFcmMessage("t", { ...base, policy: "test", channelId: "morning_brief", deepLink: "personalassistant://home" });
    expect(test.message.android.ttl).toBe("300s");
  });
});

describe("sendFcm：错误映射表", () => {
  const message = buildFcmMessage("device-token", {
    v: "1",
    policy: "commute_disruption",
    channelId: "commute_disruption",
    deepLink: "personalassistant://home",
    notificationKey: "commute_disruption",
    title: "t",
    body: "b",
    sentAt: "2026-09-23T07:00:00Z",
  });

  function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  it("2xx → ok", async () => {
    mockGoogle({ fcm: () => jsonResponse({ name: "projects/p/messages/1" }, 200) });
    const outcome = await sendFcm("access-token", "test-project", message);
    expect(outcome).toBe("ok");
  });

  it("404 → unregistered", async () => {
    mockGoogle({ fcm: () => jsonResponse(fcmErrorNotFound, 404) });
    expect(await sendFcm("t", "p", message)).toBe("unregistered");
  });

  it("400 + errorCode UNREGISTERED → unregistered", async () => {
    mockGoogle({ fcm: () => jsonResponse(fcmErrorUnregistered, 400) });
    expect(await sendFcm("t", "p", message)).toBe("unregistered");
  });

  it("400 其他（INVALID_ARGUMENT）→ invalid_argument", async () => {
    mockGoogle({ fcm: () => jsonResponse(fcmErrorInvalidArgument, 400) });
    expect(await sendFcm("t", "p", message)).toBe("invalid_argument");
  });

  it("401 → auth_error", async () => {
    mockGoogle({ fcm: () => jsonResponse(fcmErrorUnauthenticated, 401) });
    expect(await sendFcm("t", "p", message)).toBe("auth_error");
  });

  it("403（含 SENDER_ID_MISMATCH）→ sender_mismatch", async () => {
    mockGoogle({ fcm: () => jsonResponse(fcmErrorSenderMismatch, 403) });
    expect(await sendFcm("t", "p", message)).toBe("sender_mismatch");
  });

  it("429 → rate_limited", async () => {
    mockGoogle({ fcm: () => jsonResponse(fcmErrorRateLimited, 429) });
    expect(await sendFcm("t", "p", message)).toBe("rate_limited");
  });

  it("其他 4xx（418）→ upstream_4xx", async () => {
    mockGoogle({ fcm: () => new Response("teapot", { status: 418 }) });
    expect(await sendFcm("t", "p", message)).toBe("upstream_4xx");
  });

  it("错误体不是 JSON 的 500 → upstream_5xx", async () => {
    mockGoogle({ fcm: () => new Response("server error", { status: 500 }) });
    expect(await sendFcm("t", "p", message)).toBe("upstream_5xx");
  });

  it("503 → upstream_5xx", async () => {
    mockGoogle({ fcm: () => jsonResponse(fcmErrorUnavailable, 503) });
    expect(await sendFcm("t", "p", message)).toBe("upstream_5xx");
  });

  it("网络错误（非中止）→ network", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    expect(await sendFcm("t", "p", message)).toBe("network");
  });

  it("超时（timeoutMs 用小值）→ timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject((signal as AbortSignal).reason));
      });
    });
    expect(await sendFcm("t", "p", message, undefined, { timeoutMs: 10 })).toBe("timeout");
  }, 10000);

  it("外部 signal 已中止 → aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal;
      if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    expect(await sendFcm("t", "p", message, controller.signal)).toBe("aborted");
  });

  it("请求 URL 含 project_id，Authorization 头为 Bearer <token>", async () => {
    const handle = mockGoogle();
    await sendFcm("my-access-token", "my-project-123", message);
    const call = handle.fcmCalls[0];
    if (!call) throw new Error("expected fcm call");
    expect(call.url).toBe("https://fcm.googleapis.com/v1/projects/my-project-123/messages:send");
    expect(call.headers.get("authorization")).toBe("Bearer my-access-token");
  });
});
