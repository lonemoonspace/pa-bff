// src/secrets/store.ts + testers.ts 的单元测试：不走 HTTP，直接调用存取函数。
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteSecret, getSecretPlain, getSecretStatus, listStatus, putSecret, retest, SecretNameSchema } from "../../src/secrets/store";
import { registerTester, unregisterTesterForTest } from "../../src/secrets/testers";
import { instrumentD1 } from "../helpers/d1-counter";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM secrets");
});

describe("putSecret / getSecretPlain", () => {
  it("保存后能读出明文，hint 是末 4 位脱敏", async () => {
    const result = await putSecret(env, "google_routes", "AIzaSyTest12345");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.status.state).toBe("present");
    expect(result.status.hint).toBe("···2345");

    const plain = await getSecretPlain(env, "google_routes");
    expect(plain).toBe("AIzaSyTest12345");
  });

  it("fcm_service_account 必须是含 project_id / client_email / private_key 的 JSON，否则 invalid_value", async () => {
    const bad = await putSecret(env, "fcm_service_account", JSON.stringify({ foo: "bar" }));
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    expect(bad.code).toBe("invalid_value");

    const notJson = await putSecret(env, "fcm_service_account", "not-json");
    expect(notJson.ok).toBe(false);

    // 缺 project_id 单独校验一次：[gate] P5 修订加了这个必需字段。
    const missingProjectId = await putSecret(
      env,
      "fcm_service_account",
      JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----" }),
    );
    expect(missingProjectId.ok).toBe(false);

    const good = await putSecret(
      env,
      "fcm_service_account",
      JSON.stringify({
        project_id: "test-project",
        client_email: "a@b.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----",
      }),
    );
    expect(good.ok).toBe(true);
  });

  it("空字符串（或全空白）不合法", async () => {
    const result = await putSecret(env, "football_data", "   ");
    expect(result.ok).toBe(false);
  });
});

describe("listStatus", () => {
  it("未写入的密钥 → missing，hint 与 lastTest 均为 null", async () => {
    const list = await listStatus(env);
    expect(list).toHaveLength(3);
    for (const status of list) {
      expect(status.state).toBe("missing");
      expect(status.hint).toBeNull();
      expect(status.lastTest).toBeNull();
    }
  });

  it("换 MASTER_KEY 后 → unreadable", async () => {
    await putSecret(env, "google_routes", "AIzaSyTest12345");
    const before = await listStatus(env);
    expect(before.find((s) => s.name === "google_routes")?.state).toBe("present");

    const original = env.MASTER_KEY;
    env.MASTER_KEY = "qFB4cnGQDOVhQdsMfCF43cXV67KNail+S8+2dkwc4jw=";
    try {
      const after = await listStatus(env);
      expect(after.find((s) => s.name === "google_routes")?.state).toBe("unreadable");
    } finally {
      env.MASTER_KEY = original;
    }
  });

  it("只发 1 次 D1 查询，且三种状态（missing / present / unreadable）与逐个 getSecretStatus 深相等", async () => {
    // google_routes → present；football_data 不写 → missing；fcm_service_account 写入后
    // 直接把它的密文改成垃圾数据 → 只有这一行 unreadable（不像换 MASTER_KEY 那样把所有
    // present 的行一起变 unreadable，这样才能在同一次 listStatus 里同时验到三种状态）。
    await putSecret(env, "google_routes", "AIzaSyTest12345");
    await putSecret(
      env,
      "fcm_service_account",
      JSON.stringify({
        project_id: "test-project",
        client_email: "a@b.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----",
      }),
    );
    await env.DB.prepare("UPDATE secrets SET ciphertext = 'not-valid-base64-ciphertext' WHERE name = 'fcm_service_account'").run();

    const expected = await Promise.all(SecretNameSchema.options.map((name) => getSecretStatus(env, name)));
    expect(expected.find((s) => s.name === "google_routes")?.state).toBe("present");
    expect(expected.find((s) => s.name === "football_data")?.state).toBe("missing");
    expect(expected.find((s) => s.name === "fcm_service_account")?.state).toBe("unreadable");

    const counted = instrumentD1(env.DB);
    const actual = await listStatus({ ...env, DB: counted.db });
    expect(counted.count()).toBe(1);
    expect(actual).toEqual(expected);
  });
});

describe("registerTester 与 PUT 立即测试", () => {
  it("未注册 tester → lastTest 为「尚不支持测试」", async () => {
    unregisterTesterForTest("football_data");
    const result = await putSecret(env, "football_data", "token-value");
    if (!result.ok) throw new Error("unreachable");
    expect(result.status.lastTest?.ok).toBe(false);
    expect(result.status.lastTest?.message).toBe("尚不支持测试");
  });

  it("注册 tester 后 PUT 立即调用，结果写入 lastTest", async () => {
    registerTester("football_data", async (_env, plaintext) => ({
      ok: plaintext === "good-token",
      message: plaintext === "good-token" ? "ok" : "bad",
    }));
    const result = await putSecret(env, "football_data", "good-token");
    if (!result.ok) throw new Error("unreachable");
    expect(result.status.lastTest).toEqual({ ok: true, at: result.status.lastTest?.at, message: "ok" });
  });

  it("tester 抛异常不会中断保存，lastTest.ok 为 false", async () => {
    registerTester("football_data", async () => {
      throw new Error("network down");
    });
    const result = await putSecret(env, "football_data", "any-token");
    if (!result.ok) throw new Error("unreachable");
    expect(result.status.state).toBe("present");
    expect(result.status.lastTest?.ok).toBe(false);

    const plain = await getSecretPlain(env, "football_data");
    expect(plain).toBe("any-token");
  });
});

describe("retest", () => {
  afterEach(() => {
    registerTester("football_data", async () => ({ ok: false, message: "尚不支持测试" }));
  });

  it("对已存密钥重新调用 tester，写回 last_test_json", async () => {
    let calls = 0;
    registerTester("football_data", async () => {
      calls += 1;
      return { ok: true, message: `call-${calls}` };
    });
    await putSecret(env, "football_data", "token");
    const status = await retest(env, "football_data");
    expect(status.lastTest?.message).toBe("call-2");
  });

  it("密钥缺失时直接返回 missing，不写 last_test_json", async () => {
    const status = await retest(env, "google_routes");
    expect(status.state).toBe("missing");
    expect(status.lastTest).toBeNull();
  });
});

describe("deleteSecret", () => {
  it("删除后状态变回 missing", async () => {
    await putSecret(env, "google_routes", "value12345");
    await deleteSecret(env, "google_routes");
    const status = (await listStatus(env)).find((s) => s.name === "google_routes");
    expect(status?.state).toBe("missing");
    expect(await getSecretPlain(env, "google_routes")).toBeNull();
  });
});
