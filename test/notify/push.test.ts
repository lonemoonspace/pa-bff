// notify/push.ts 的单元测试：目标设备、发送、令牌清理、push_log、至多一次的各种边界。
// 用 T5.1 的 fcm-mock.ts 假 Google 端点，不访问真实网络；D1 次数用 test/helpers/d1-counter.ts 断言。
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importMasterKey, seal } from "../../src/crypto/secretbox";
import { db } from "../../src/db/client";
import { secrets } from "../../src/db/schema";
import { resetFcmCacheForTest } from "../../src/notify/fcm";
import { deliver, toOutgoing, type OutgoingPush } from "../../src/notify/push";
import { instrumentD1 } from "../helpers/d1-counter";
import { makeTestServiceAccount, mockGoogle } from "../helpers/fcm-mock";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM secrets");
  await env.DB.exec("DELETE FROM push_log");
  resetFcmCacheForTest();
});

afterEach(() => {
  resetFcmCacheForTest();
});

let deviceSeq = 0;

/** 直接插入一台设备（跳过认领/配对流程），push token 用 secretbox purpose "push_token" 加密。 */
async function insertDevice(
  opts: { token?: string | null; revoked?: boolean; createdAt?: string; ciphertextOverride?: { ct: string; iv: string } } = {},
): Promise<{ id: string; ciphertext: string | null }> {
  deviceSeq += 1;
  const id = `dev-${deviceSeq}`;
  const createdAt = opts.createdAt ?? new Date(2026, 0, 1, 0, 0, deviceSeq).toISOString();
  let ct: string | null = null;
  let iv: string | null = null;
  if (opts.ciphertextOverride) {
    ct = opts.ciphertextOverride.ct;
    iv = opts.ciphertextOverride.iv;
  } else if (opts.token !== null) {
    const key = await importMasterKey(env.MASTER_KEY);
    const sealed = await seal(key, opts.token ?? "fake-fcm-token", "push_token");
    ct = sealed.ciphertext;
    iv = sealed.iv;
  }
  await env.DB.prepare(
    `INSERT INTO devices (id, name, role, token_hash, push_token_ct, push_token_iv, created_at, last_seen_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, `device-${deviceSeq}`, "owner", `hash-${deviceSeq}`, ct, iv, createdAt, createdAt, opts.revoked ? createdAt : null)
    .run();
  return { id, ciphertext: ct };
}

/** 直接插入 fcm_service_account 密钥（跳过 putSecret 触发的 tester，避免额外的 oauth 调用）。 */
async function insertFcmSecret(json: string): Promise<void> {
  const key = await importMasterKey(env.MASTER_KEY);
  const sealed = await seal(key, json, "secret:fcm_service_account");
  await db(env)
    .insert(secrets)
    .values({ name: "fcm_service_account", ciphertext: sealed.ciphertext, iv: sealed.iv, hint: "···test", lastTestJson: null, updatedAt: new Date().toISOString() });
}

function items(n = 1): OutgoingPush[] {
  return Array.from({ length: n }, (_, i) => ({
    policy: "commute_disruption" as const,
    title: `标题${i}`,
    body: `正文${i}`,
    notificationKey: "commute_disruption",
  }));
}

const NOW = new Date("2026-09-26T08:00:00Z");

async function fullResultBody(res: { at: string; policy: string; title: string; body: string; device_count: number; result: string }[]) {
  return res.map((r) => ({ ...r, result: JSON.parse(r.result) }));
}

async function readPushLog() {
  const { results } = await env.DB.prepare("SELECT at, policy, title, body, device_count, result FROM push_log ORDER BY id").all<{
    at: string;
    policy: string;
    title: string;
    body: string;
    device_count: number;
    result: string;
  }>();
  return fullResultBody(results);
}

describe("toOutgoing", () => {
  it("commute / morning / test 用 policy 名做 key", () => {
    expect(toOutgoing("commute_disruption", { title: "t", body: "b" }).notificationKey).toBe("commute_disruption");
    expect(toOutgoing("morning_brief", { title: "t", body: "b" }).notificationKey).toBe("morning_brief");
    expect(toOutgoing("test", { title: "t", body: "b" }).notificationKey).toBe("test");
  });
  it("football 用 football:<matchId>", () => {
    expect(toOutgoing("football", { title: "t", body: "b", matchId: "m1" }).notificationKey).toBe("football:m1");
  });
  it("ticket 用 ticket:<kind>", () => {
    expect(toOutgoing("ticket", { title: "t", body: "b", kind: "TRANSIT" }).notificationKey).toBe("ticket:TRANSIT");
    expect(toOutgoing("ticket", { title: "t", body: "b", kind: "PARKING" }).notificationKey).toBe("ticket:PARKING");
  });
});

describe("deliver()", () => {
  it("2 台设备 × 1 条 → 1 次 oauth + 2 次 FCM，push_log 一行 sent，device_count 2", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    await insertDevice();
    const google = mockGoogle();

    const results = await deliver(env, items(1), NOW, undefined);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "sent", reason: null, sent: 2, failed: 0, unregistered: 0, codes: {} });
    expect(google.oauthCalls).toHaveLength(1);
    expect(google.fcmCalls).toHaveLength(2);

    // data 字段与 PushDataSchema 相等（逐一）
    for (const call of google.fcmCalls) {
      const body = JSON.parse(call.bodyText) as { message: { data: Record<string, string> } };
      expect(body.message.data.v).toBe("1");
      expect(body.message.data.policy).toBe("commute_disruption");
      expect(body.message.data.channelId).toBe("commute_disruption");
      expect(body.message.data.deepLink).toBe("personalassistant://home");
      expect(body.message.data.notificationKey).toBe("commute_disruption");
      expect(body.message.data.title).toBe("标题0");
      expect(body.message.data.body).toBe("正文0");
      expect(body.message.data.sentAt).toBe(NOW.toISOString());
    }

    const log = await readPushLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.device_count).toBe(2);
    expect(log[0]?.result).toMatchObject({ status: "sent", sent: 2 });
  });

  it("吊销设备与无 token 设备不在目标里；deviceIds 过滤生效", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    const a = await insertDevice();
    await insertDevice({ revoked: true });
    await insertDevice({ token: null });
    const google = mockGoogle();

    const all = await deliver(env, items(1), NOW, undefined);
    expect(google.fcmCalls).toHaveLength(1); // 只有 a 是有效目标

    google.fcmCalls.length = 0;
    const filtered = await deliver(env, items(1), NOW, undefined, { deviceIds: [a.id] });
    expect(google.fcmCalls).toHaveLength(1);
    expect(all[0]?.sent).toBe(1);
    expect(filtered[0]?.sent).toBe(1);
  });

  it("无设备 → 不读密钥、不发请求，push_log skipped/no_devices，device_count 0", async () => {
    const google = mockGoogle();
    const results = await deliver(env, items(1), NOW, undefined);
    expect(results[0]).toEqual({ status: "skipped", reason: "no_devices", sent: 0, failed: 0, unregistered: 0, codes: {} });
    expect(google.oauthCalls).toHaveLength(0);
    expect(google.fcmCalls).toHaveLength(0);
    const log = await readPushLog();
    expect(log[0]?.device_count).toBe(0);
    expect(log[0]?.result).toEqual({ status: "skipped", reason: "no_devices", sent: 0, failed: 0, unregistered: 0, codes: {} });
  });

  it("密钥缺失 → fcm_not_configured，0 次外部请求", async () => {
    await insertDevice();
    const google = mockGoogle();
    const results = await deliver(env, items(1), NOW, undefined);
    expect(results[0]).toEqual({ status: "skipped", reason: "fcm_not_configured", sent: 0, failed: 0, unregistered: 0, codes: {} });
    expect(google.oauthCalls).toHaveLength(0);
    expect(google.fcmCalls).toHaveLength(0);
  });

  it("oauth 400 → 0 次 FCM，每条 skipped/fcm_auth_failed", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    await insertDevice();
    const google = mockGoogle({
      oauth: () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } }),
    });

    const results = await deliver(env, items(2), NOW, undefined);
    expect(google.fcmCalls).toHaveLength(0);
    for (const r of results) {
      expect(r).toEqual({ status: "skipped", reason: "fcm_auth_failed", sent: 0, failed: 2, unregistered: 0, codes: { skipped_auth: 2 } });
    }
  });

  it("404 UNREGISTERED 的设备 token 被清空，另一台保留；竞态下新 token 不被清空", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    const a = await insertDevice();
    const b = await insertDevice();
    let call = 0;
    mockGoogle({
      fcm: () => {
        call += 1;
        if (call === 1) {
          return new Response(JSON.stringify({ error: { details: [{ errorCode: "UNREGISTERED" }] } }), { status: 400 });
        }
        return new Response(JSON.stringify({ name: "ok" }), { status: 200 });
      },
    });

    const results = await deliver(env, items(1), NOW, undefined);
    expect(results[0]?.codes.unregistered).toBe(1);
    const rows = await env.DB.prepare("SELECT id, push_token_ct FROM devices ORDER BY id").all<{ id: string; push_token_ct: string | null }>();
    const byId = new Map(rows.results.map((r) => [r.id, r.push_token_ct]));
    expect(byId.get(a.id)).toBeNull();
    expect(byId.get(b.id)).not.toBeNull();
  });

  it("竞态：清理语句执行前设备 token 已被换成新密文 → 新 token 不被清空", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    const a = await insertDevice();
    const google = mockGoogle({
      fcm: () => new Response(JSON.stringify({ error: { details: [{ errorCode: "UNREGISTERED" }] } }), { status: 400 }),
    });

    const NEW_TOKEN_CT = "brand-new-ciphertext";
    const counted = instrumentD1(env.DB, {
      onPrepare: async (sql) => {
        if (sql.startsWith("UPDATE devices SET push_token_ct = NULL")) {
          await env.DB.prepare("UPDATE devices SET push_token_ct = ?, push_token_iv = ? WHERE id = ?")
            .bind(NEW_TOKEN_CT, "iv", a.id)
            .run();
        }
      },
    });
    const testEnv = { ...env, DB: counted.db };

    const results = await deliver(testEnv, items(1), NOW, undefined);
    expect(results[0]?.codes.unregistered).toBe(1);
    const row = await env.DB.prepare("SELECT push_token_ct FROM devices WHERE id = ?").bind(a.id).first<{ push_token_ct: string }>();
    expect(row?.push_token_ct).toBe(NEW_TOKEN_CT);
    void google;
  });

  it("429 后其余记 skipped_rate_limited，FCM 实际只被调用到 429 那一次为止", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    await insertDevice();
    await insertDevice();
    const google = mockGoogle({ fcm: () => new Response("rate limited", { status: 429 }) });

    const results = await deliver(env, items(1), NOW, undefined);
    expect(google.fcmCalls).toHaveLength(1);
    expect(results[0]?.codes.rate_limited).toBe(1);
    expect(results[0]?.codes.skipped_rate_limited).toBe(2);
  });

  it("401 后其余记 skipped_auth，且下一次 deliver 会重新取 oauth", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    await insertDevice();
    const google = mockGoogle({ fcm: () => new Response("unauthorized", { status: 401 }) });

    const results = await deliver(env, items(1), NOW, undefined);
    expect(google.oauthCalls).toHaveLength(1);
    expect(results[0]?.codes.auth_error).toBe(1);
    expect(results[0]?.codes.skipped_auth).toBe(1);

    await deliver(env, items(1), NOW, undefined);
    expect(google.oauthCalls).toHaveLength(2); // 401 清了缓存，第二次 deliver 重新取令牌
  });

  it("6 条 × 2 台 → 恰好 10 次 FCM，最后一条 skipped/budget", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    await insertDevice();
    const google = mockGoogle();

    const results = await deliver(env, items(6), NOW, undefined);
    expect(google.fcmCalls).toHaveLength(10);
    const last = results[5];
    expect(last).toEqual({ status: "skipped", reason: "budget", sent: 0, failed: 2, unregistered: 0, codes: { skipped_budget: 2 } });
    // sent + Σcodes = deviceCount 对每一条都成立（budget 场景也一样，因为 codes 里显式记了 skipped_budget）
    for (const r of results) {
      const codesSum = Object.values(r.codes).reduce((a, b) => a + b, 0);
      expect(r.sent + codesSum).toBe(2);
    }
  });

  it("第一条发送途中外部 signal 中止 → 其余 aborted，push_log 仍写入", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    await insertDevice();
    const controller = new AbortController();
    let first = true;
    const google = mockGoogle({
      fcm: () => {
        if (first) {
          first = false;
          controller.abort();
        }
        return new Response(JSON.stringify({ name: "ok" }), { status: 200 });
      },
    });

    const results = await deliver(env, items(2), NOW, controller.signal);
    expect(results[0]?.codes.aborted).toBeGreaterThanOrEqual(1);
    expect(results[1]).toEqual({ status: "skipped", reason: "aborted", sent: 0, failed: 2, unregistered: 0, codes: { aborted: 2 } });
    const log = await readPushLog();
    expect(log).toHaveLength(2);
    void google;
  });

  it("某台 token 解密失败 → token_unreadable，另一台照发，status partial", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice(); // 正常
    await insertDevice({ ciphertextOverride: { ct: "not-a-valid-ciphertext", iv: "AAAAAAAAAAAAAAAA" } });
    const google = mockGoogle();

    const results = await deliver(env, items(1), NOW, undefined);
    expect(results[0]?.status).toBe("partial");
    expect(results[0]?.codes.token_unreadable).toBe(1);
    expect(results[0]?.sent).toBe(1);
    void google;
  });

  it("FCM 500 → failed；函数 resolve 不 reject", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    mockGoogle({ fcm: () => new Response("boom", { status: 500 }) });

    await expect(deliver(env, items(1), NOW, undefined)).resolves.toBeDefined();
    const results = await deliver(env, items(1), NOW, undefined);
    expect(results[0]?.status).toBe("failed");
  });

  it("预算：最坏情况（4 条 × 2 台、1 台 unregistered）D1 ≤ 4、fetch ≤ 9", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    await insertDevice();
    let call = 0;
    mockGoogle({
      fcm: () => {
        call += 1;
        if (call === 1) return new Response(JSON.stringify({ error: { details: [{ errorCode: "UNREGISTERED" }] } }), { status: 400 });
        return new Response(JSON.stringify({ name: "ok" }), { status: 200 });
      },
    });

    const counted = instrumentD1(env.DB);
    const testEnv = { ...env, DB: counted.db };
    const results = await deliver(testEnv, items(4), NOW, undefined);
    expect(results).toHaveLength(4);
    expect(counted.count()).toBeLessThanOrEqual(4);
    expect(call).toBeLessThanOrEqual(9);
  });

  it("push_log 与 console 输出不含 token 明文/密文、访问令牌", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    const a = await insertDevice({ token: "super-secret-fcm-token-value" });
    mockGoogle();

    const consoleSpy: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      consoleSpy.push(args.map(String).join(" "));
    };
    try {
      await deliver(env, items(1), NOW, undefined);
    } finally {
      console.error = originalError;
    }

    const log = await readPushLog();
    const logText = JSON.stringify(log);
    expect(logText).not.toContain("super-secret-fcm-token-value");
    expect(logText).not.toContain("test-access-token");
    const row = await env.DB.prepare("SELECT push_token_ct FROM devices WHERE id = ?").bind(a.id).first<{ push_token_ct: string }>();
    expect(logText).not.toContain(row?.push_token_ct ?? "__never__");
    for (const line of consoleSpy) {
      expect(line).not.toContain("super-secret-fcm-token-value");
      expect(line).not.toContain("test-access-token");
    }
  });

  it("T5.6 (a) 唯一设备 push token 无法解密 → skipped/token_unreadable", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice({ ciphertextOverride: { ct: "not-a-valid-ciphertext", iv: "AAAAAAAAAAAAAAAA" } });
    const google = mockGoogle();

    const results = await deliver(env, items(1), NOW, undefined);
    expect(results[0]).toEqual({ status: "skipped", reason: "token_unreadable", sent: 0, failed: 1, unregistered: 0, codes: { token_unreadable: 1 } });
    void google;
  });

  it("T5.6 (b) 两条通知、第一条 429 → 第二条 skipped/rate_limited", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    mockGoogle({ fcm: () => new Response("rate limited", { status: 429 }) });

    const results = await deliver(env, items(2), NOW, undefined);
    expect(results[0]?.status).toBe("failed"); // 第一条真的发出过请求，只是被 429 拒了
    expect(results[1]).toEqual({ status: "skipped", reason: "rate_limited", sent: 0, failed: 1, unregistered: 0, codes: { skipped_rate_limited: 1 } });
  });

  it("T5.6 (d) 已中止 signal + 1 台设备 → oauth 0 次、reason: aborted", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    const google = mockGoogle();
    const controller = new AbortController();
    controller.abort();

    const results = await deliver(env, items(1), NOW, controller.signal);
    expect(google.oauthCalls).toHaveLength(0);
    expect(google.fcmCalls).toHaveLength(0);
    expect(results[0]).toEqual({ status: "skipped", reason: "aborted", sent: 0, failed: 1, unregistered: 0, codes: { aborted: 1 } });
  });

  it("T5.6 (e) deliver 内部意外异常 → reason: internal", async () => {
    await insertDevice();
    const counted = instrumentD1(env.DB, {
      onPrepare: (sql) => {
        if (sql.includes("FROM devices")) throw new Error("d1 意外故障");
      },
    });
    const testEnv = { ...env, DB: counted.db };

    const results = await deliver(testEnv, items(1), NOW, undefined);
    expect(results[0]).toEqual({ status: "skipped", reason: "internal", sent: 0, failed: 0, unregistered: 0, codes: {} });
  });

  it("T5.6 (c) 各种 skipped 场景下 reason 均非 null", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    const google = mockGoogle();

    // no_devices
    await env.DB.exec("DELETE FROM devices");
    const noDevices = await deliver(env, items(1), NOW, undefined);
    expect(noDevices[0]?.status).toBe("skipped");
    expect(noDevices[0]?.reason).not.toBeNull();

    // fcm_not_configured
    await insertDevice();
    await env.DB.exec("DELETE FROM secrets");
    const notConfigured = await deliver(env, items(1), NOW, undefined);
    expect(notConfigured[0]?.status).toBe("skipped");
    expect(notConfigured[0]?.reason).not.toBeNull();
    void google;
  });

  it("PushLogResult 恒等式：非 fcm_not_configured 场景下 sent + Σcodes = deviceCount", async () => {
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    await insertDevice();
    await insertDevice();
    mockGoogle({ fcm: () => new Response(JSON.stringify({ name: "ok" }), { status: 200 }) });

    const results = await deliver(env, items(1), NOW, undefined);
    const r = results[0];
    if (!r) throw new Error("unreachable");
    expect(r.reason === "fcm_not_configured" ? true : r.sent + Object.values(r.codes).reduce((a, b) => a + b, 0)).toBe(
      r.reason === "fcm_not_configured" ? true : 3,
    );
  });
});
