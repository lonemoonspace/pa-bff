// verifyAccessJwt() 的单元测试：现场生成 RSA 密钥对签发 JWT，按 URL 分派 fetch 返回假 JWKS，
// 不访问真实网络。契约见 CONTRACT.md 第 2 节「管理界面」。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError, resetAccessCacheForTest, verifyAccessJwt } from "../../src/auth/access";
import type { Env } from "../../src/env";
import { makeAccessTestKey, mockAccessJwks, mockAccessJwksFailure, signAccessJwt } from "../helpers/access-mock";

const DOMAIN = "test-team.cloudflareaccess.com";
const AUD = "test-aud-tag";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { ACCESS_TEAM_DOMAIN: DOMAIN, ACCESS_AUD: AUD, ...overrides } as unknown as Env;
}

function basePayload(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: `https://${DOMAIN}`,
    aud: AUD,
    exp: now + 3600,
    iat: now,
    email: "someone@example.com",
    ...overrides,
  };
}

beforeEach(() => {
  resetAccessCacheForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAccessCacheForTest();
});

describe("verifyAccessJwt", () => {
  it("合法 JWT 通过校验，返回 email", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await signAccessJwt(basePayload(), key);
    const result = await verifyAccessJwt(makeEnv(), token, new Date());
    expect(result.email).toBe("someone@example.com");
  });

  it("aud 为字符串但不匹配 → access_denied", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await signAccessJwt(basePayload({ aud: "other-aud" }), key);
    await expect(verifyAccessJwt(makeEnv(), token, new Date())).rejects.toMatchObject({ code: "access_denied" });
  });

  it("aud 为数组且不含目标 → access_denied；含目标则通过", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const badToken = await signAccessJwt(basePayload({ aud: ["a", "b"] }), key);
    await expect(verifyAccessJwt(makeEnv(), badToken, new Date())).rejects.toMatchObject({ code: "access_denied" });

    const goodToken = await signAccessJwt(basePayload({ aud: ["a", AUD] }), key);
    const result = await verifyAccessJwt(makeEnv(), goodToken, new Date());
    expect(result.email).toBe("someone@example.com");
  });

  it("iss 不对 → access_denied", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await signAccessJwt(basePayload({ iss: "https://other-team.cloudflareaccess.com" }), key);
    await expect(verifyAccessJwt(makeEnv(), token, new Date())).rejects.toMatchObject({ code: "access_denied" });
  });

  it("exp 过期超过 60 秒 → access_denied；过期 30 秒仍放行", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const now = Math.floor(Date.now() / 1000);

    const tooOld = await signAccessJwt(basePayload({ exp: now - 90 }), key);
    await expect(verifyAccessJwt(makeEnv(), tooOld, new Date())).rejects.toMatchObject({ code: "access_denied" });

    const stillOk = await signAccessJwt(basePayload({ exp: now - 30 }), key);
    const result = await verifyAccessJwt(makeEnv(), stillOk, new Date());
    expect(result.email).toBe("someone@example.com");
  });

  it("nbf 在 90 秒后 → access_denied", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const now = Math.floor(Date.now() / 1000);
    const token = await signAccessJwt(basePayload({ nbf: now + 90 }), key);
    await expect(verifyAccessJwt(makeEnv(), token, new Date())).rejects.toMatchObject({ code: "access_denied" });
  });

  it("alg: HS256 → access_denied", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await signAccessJwt(basePayload(), key, { alg: "HS256" });
    await expect(verifyAccessJwt(makeEnv(), token, new Date())).rejects.toMatchObject({ code: "access_denied" });
  });

  it("alg: none → access_denied", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await signAccessJwt(basePayload(), key, { alg: "none" });
    await expect(verifyAccessJwt(makeEnv(), token, new Date())).rejects.toMatchObject({ code: "access_denied" });
  });

  it("用另一把私钥签名 → access_denied", async () => {
    const key = await makeAccessTestKey("kid-1");
    const otherKey = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    // 用 otherKey 的私钥签名，但 header.kid 仍指向 key（JWKS 里发布的是 key 的公钥）。
    const token = await signAccessJwt(basePayload(), otherKey);
    await expect(verifyAccessJwt(makeEnv(), token, new Date())).rejects.toMatchObject({ code: "access_denied" });
  });

  it("缺 email → access_denied", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await signAccessJwt(basePayload({ email: undefined }), key);
    await expect(verifyAccessJwt(makeEnv(), token, new Date())).rejects.toMatchObject({ code: "access_denied" });
  });

  it("响应体不含 JWT 文本", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await signAccessJwt(basePayload({ iss: "https://wrong" }), key);
    try {
      await verifyAccessJwt(makeEnv(), token, new Date());
      throw new Error("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(AccessError);
      expect((err as Error).message).not.toContain(token);
    }
  });

  it("未知 kid 重取一次 JWKS，仍没有则 access_denied；轮换后的新 kid 能通过", async () => {
    const key1 = await makeAccessTestKey("kid-1");
    const handle = mockAccessJwks(DOMAIN, [key1]);

    const unknownToken = await signAccessJwt(basePayload(), await makeAccessTestKey("kid-unknown"));
    await expect(verifyAccessJwt(makeEnv(), unknownToken, new Date())).rejects.toMatchObject({ code: "access_denied" });
    expect(handle.calls.length).toBe(2); // 首次 + 未知 kid 触发的一次重取

    // 轮换：JWKS 现在换成 kid-2，之前缓存的 kid-1 已不再返回，但 kid-2 应该能立即取到。
    const key2 = await makeAccessTestKey("kid-2");
    const handle2 = mockAccessJwks(DOMAIN, [key2]);
    const rotatedToken = await signAccessJwt(basePayload(), key2);
    const result = await verifyAccessJwt(makeEnv(), rotatedToken, new Date());
    expect(result.email).toBe("someone@example.com");
    expect(handle2.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("JWKS 取失败 → access_unavailable", async () => {
    mockAccessJwksFailure();
    const key = await makeAccessTestKey("kid-1");
    const token = await signAccessJwt(basePayload(), key);
    await expect(verifyAccessJwt(makeEnv(), token, new Date())).rejects.toMatchObject({ code: "access_unavailable" });
  });

  it("缓存：同一 kid 两次请求只取 1 次 JWKS；now + 11 分钟重取", async () => {
    const key = await makeAccessTestKey("kid-1");
    const handle = mockAccessJwks(DOMAIN, [key]);
    const token = await signAccessJwt(basePayload(), key);

    const t0 = new Date();
    await verifyAccessJwt(makeEnv(), token, t0);
    expect(handle.calls.length).toBe(1);

    await verifyAccessJwt(makeEnv(), token, t0);
    expect(handle.calls.length).toBe(1);

    const t1 = new Date(t0.getTime() + 11 * 60 * 1000);
    const token2 = await signAccessJwt(basePayload(), key);
    await verifyAccessJwt(makeEnv(), token2, t1);
    expect(handle.calls.length).toBe(2);
  });
});
