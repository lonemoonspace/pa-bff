// 投递：把「一批要发的通知」变成「实际发给哪些设备」，处理令牌清理与 push_log 落库。
// 规格见 CONTRACT.md 第 6.3–6.4 节；本模块不判断策略是否该发（T5.3/T5.4 的事），
// 只管「给谁发、怎么发、发的结果怎么记」。deliver() 永不抛异常：调用方（notify 任务）
// 不应因为推送链路的任何故障（超时、5xx、oauth 失败……）而被拖住重试或阻塞调度。
import { open, importMasterKey } from "../crypto/secretbox";
import type { Env } from "../env";
import { getSecretPlain } from "../secrets/store";
import { MAX_FCM_SENDS_PER_RUN, PUSH_ROUTING, PushLogResultSchema } from "../contract/push";
import type { PushData, PushLogPolicy, PushLogResult, PushOutcome } from "../contract/push";
import { FcmAuthError, buildFcmMessage, getAccessToken, invalidateAccessToken, parseServiceAccount, sendFcm } from "./fcm";

/** 一条待发送的通知：由 notify 任务（T5.4）或测试推送（T5.5）构造。 */
export interface OutgoingPush {
  policy: PushLogPolicy;
  title: string;
  body: string;
  notificationKey: string;
}

/**
 * 各策略产出的通知对象形状不完全一样（football 带 matchId，ticket 带 kind），
 * 这里按 policy 派生 notificationKey：
 *   commute_disruption / morning_brief / test -> policy 名本身
 *   football -> "football:<matchId>"
 *   ticket   -> "ticket:<kind>"（kind 为 "TRANSIT" | "PARKING"）
 */
export interface NotificationLike {
  title: string;
  body: string;
  matchId?: string;
  kind?: "TRANSIT" | "PARKING";
}

export function toOutgoing(policy: PushLogPolicy, n: NotificationLike): OutgoingPush {
  let notificationKey: string;
  if (policy === "football") {
    if (!n.matchId) throw new Error("football 通知缺少 matchId");
    notificationKey = `football:${n.matchId}`;
  } else if (policy === "ticket") {
    if (!n.kind) throw new Error("ticket 通知缺少 kind");
    notificationKey = `ticket:${n.kind}`;
  } else {
    notificationKey = policy;
  }
  return { policy, title: n.title, body: n.body, notificationKey };
}

function buildPushData(item: OutgoingPush, now: Date): PushData {
  const routing = PUSH_ROUTING[item.policy];
  return {
    v: "1",
    policy: item.policy,
    channelId: routing.channelId,
    deepLink: routing.deepLink,
    notificationKey: item.notificationKey,
    title: item.title,
    body: item.body,
    sentAt: now.toISOString(),
  };
}

interface TargetDevice {
  id: string;
  pushTokenCt: string;
  pushTokenIv: string;
}

/** 第 2 步：目标设备——已认领/配对且未吊销、有 push token 的设备，按 created_at, id 升序。 */
async function loadTargetDevices(env: Env, deviceIds?: string[]): Promise<TargetDevice[]> {
  if (deviceIds !== undefined && deviceIds.length === 0) return [];

  let query = "SELECT id, push_token_ct, push_token_iv FROM devices WHERE revoked_at IS NULL AND push_token_ct IS NOT NULL";
  const binds: unknown[] = [];
  if (deviceIds !== undefined) {
    query += ` AND id IN (${deviceIds.map(() => "?").join(",")})`;
    binds.push(...deviceIds);
  }
  query += " ORDER BY created_at, id";

  const { results } = await env.DB.prepare(query)
    .bind(...binds)
    .all<{ id: string; push_token_ct: string; push_token_iv: string }>();
  return results.map((r) => ({ id: r.id, pushTokenCt: r.push_token_ct, pushTokenIv: r.push_token_iv }));
}

/** 第 4 步：解密各设备 push token；失败的记为 null（不抛异常，调用方按 token_unreadable 处理）。 */
async function decryptDeviceTokens(env: Env, targets: TargetDevice[]): Promise<Map<string, string | null>> {
  const key = await importMasterKey(env.MASTER_KEY);
  const map = new Map<string, string | null>();
  for (const t of targets) {
    const plain = await open(key, { ciphertext: t.pushTokenCt, iv: t.pushTokenIv }, "push_token");
    map.set(t.id, plain);
  }
  return map;
}

/** 第 7 步：清空「确认已注销」设备的 push token，条件带上发送前读到的密文，一条语句合并多台。 */
async function clearUnregisteredTokens(env: Env, clears: { id: string; ciphertext: string }[]): Promise<void> {
  if (clears.length === 0) return;
  const conditions = clears.map(() => "(id = ? AND push_token_ct = ?)").join(" OR ");
  const binds = clears.flatMap((c) => [c.id, c.ciphertext]);
  await env.DB.prepare(`UPDATE devices SET push_token_ct = NULL, push_token_iv = NULL WHERE ${conditions}`)
    .bind(...binds)
    .run();
}

/** 第 8 步：一条多行 INSERT 写 push_log，每条通知一行。 */
async function writePushLog(env: Env, items: OutgoingPush[], now: Date, deviceCount: number, results: PushLogResult[]): Promise<void> {
  if (items.length === 0) return;
  const at = now.toISOString();
  const rowsSql = items.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
  const binds: unknown[] = [];
  items.forEach((item, i) => {
    const result = PushLogResultSchema.parse(results[i]);
    binds.push(at, item.policy, item.title, item.body, deviceCount, JSON.stringify(result));
  });
  await env.DB.prepare(`INSERT INTO push_log (at, policy, title, body, device_count, result) VALUES ${rowsSql}`)
    .bind(...binds)
    .run();
}

const SKIPPED_NO_DEVICES: PushLogResult = { status: "skipped", reason: "no_devices", sent: 0, failed: 0, unregistered: 0, codes: {} };

function skippedFcmNotConfigured(): PushLogResult {
  return { status: "skipped", reason: "fcm_not_configured", sent: 0, failed: 0, unregistered: 0, codes: {} };
}

function skippedFcmAuthFailed(deviceCount: number): PushLogResult {
  return {
    status: "skipped",
    reason: "fcm_auth_failed",
    sent: 0,
    failed: deviceCount,
    unregistered: 0,
    codes: deviceCount > 0 ? { skipped_auth: deviceCount } : {},
  };
}

interface DeviceOutcomeEntry {
  outcome: PushOutcome;
  /** 是否真的发出过一次 FCM 请求（区分“主动跳过”与“确实尝试过”，决定 status 是否为 skipped）。 */
  attempted: boolean;
}

/**
 * 「未发出任何 FCM 请求」时，reason 按优先级 aborted > budget > fcm_auth_failed >
 * rate_limited > token_unreadable 确定（T5.6 修复 2）：不能按 entries 数组里出现的
 * 先后顺序取第一个，因为同一条通知里不同设备可能撞上不同的跳过原因（例如一台设备
 * 提前中止、另一台只是解不开 token），必须按这张固定优先级表选，跟 entries 顺序无关。
 */
const REASON_PRIORITY: readonly PushOutcome[] = ["aborted", "skipped_budget", "skipped_auth", "skipped_rate_limited", "token_unreadable"];
const SKIP_REASON_OF: Partial<Record<PushOutcome, PushLogResult["reason"]>> = {
  aborted: "aborted",
  skipped_budget: "budget",
  skipped_auth: "fcm_auth_failed",
  skipped_rate_limited: "rate_limited",
  token_unreadable: "token_unreadable",
};

function computeResult(entries: DeviceOutcomeEntry[], deviceCount: number): PushLogResult {
  const codes: Record<string, number> = {};
  let sent = 0;
  let anyAttempted = false;
  for (const e of entries) {
    if (e.attempted) anyAttempted = true;
    if (e.outcome === "ok") sent += 1;
    else codes[e.outcome] = (codes[e.outcome] ?? 0) + 1;
  }
  const unregistered = codes.unregistered ?? 0;
  const codesSum = Object.values(codes).reduce((a, b) => a + b, 0);
  const failed = codesSum - unregistered;

  if (!anyAttempted) {
    let reason: PushLogResult["reason"] = null;
    for (const outcome of REASON_PRIORITY) {
      if (entries.some((e) => e.outcome === outcome)) {
        reason = SKIP_REASON_OF[outcome] ?? null;
        break;
      }
    }
    return { status: "skipped", reason, sent: 0, failed, unregistered, codes };
  }
  if (sent === deviceCount) return { status: "sent", reason: null, sent, failed, unregistered, codes };
  if (sent > 0) return { status: "partial", reason: null, sent, failed, unregistered, codes };
  return { status: "failed", reason: null, sent, failed, unregistered, codes };
}

/**
 * 主循环：按 items 顺序、每条内按设备顺序串行发送。全局（跨 items）状态：
 * 已发送次数（预算）、429/401 触发后的“本轮其余”跳过、外部 signal 中止。
 */
async function runSendLoop(
  projectId: string,
  accessToken: string,
  items: OutgoingPush[],
  targets: TargetDevice[],
  decrypted: Map<string, string | null>,
  now: Date,
  signal: AbortSignal | undefined,
  unregisteredClears: { id: string; ciphertext: string }[],
): Promise<PushLogResult[]> {
  const perItemEntries: DeviceOutcomeEntry[][] = items.map(() => []);
  let sendCount = 0;
  let stopCode: "skipped_rate_limited" | "skipped_auth" | null = null;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const entries = perItemEntries[i];
    if (!item || !entries) continue; // 不会发生：两个数组同构，仅为满足 noUncheckedIndexedAccess
    const pushData = buildPushData(item, now);
    for (const target of targets) {
      const token = decrypted.get(target.id) ?? null;
      if (token === null) {
        entries.push({ outcome: "token_unreadable", attempted: false });
        continue;
      }
      if (signal?.aborted) {
        entries.push({ outcome: "aborted", attempted: false });
        continue;
      }
      if (stopCode) {
        entries.push({ outcome: stopCode, attempted: false });
        continue;
      }
      if (sendCount >= MAX_FCM_SENDS_PER_RUN) {
        entries.push({ outcome: "skipped_budget", attempted: false });
        continue;
      }

      const message = buildFcmMessage(token, pushData);
      // eslint-disable-next-line no-await-in-loop -- 规格要求串行发送，不能并发
      const outcome = await sendFcm(accessToken, projectId, message, signal);
      sendCount += 1;
      entries.push({ outcome, attempted: true });

      if (outcome === "unregistered") {
        unregisteredClears.push({ id: target.id, ciphertext: target.pushTokenCt });
      } else if (outcome === "rate_limited") {
        stopCode = "skipped_rate_limited";
      } else if (outcome === "auth_error") {
        invalidateAccessToken();
        stopCode = "skipped_auth";
      }
    }
  }

  return perItemEntries.map((entries) => computeResult(entries, targets.length));
}

export interface DeliverOptions {
  deviceIds?: string[];
}

async function deliverInner(
  env: Env,
  items: OutgoingPush[],
  now: Date,
  signal: AbortSignal | undefined,
  opts: DeliverOptions,
): Promise<PushLogResult[]> {
  const targets = await loadTargetDevices(env, opts.deviceIds);
  const deviceCount = targets.length;
  const unregisteredClears: { id: string; ciphertext: string }[] = [];
  let results: PushLogResult[];

  if (deviceCount === 0) {
    results = items.map(() => SKIPPED_NO_DEVICES);
  } else {
    const plaintext = await getSecretPlain(env, "fcm_service_account");
    const sa = plaintext ? parseServiceAccount(plaintext) : null;
    if (!sa) {
      results = items.map(() => skippedFcmNotConfigured());
    } else {
      const decrypted = await decryptDeviceTokens(env, targets);
      // T5.6 修复 3：先看调度信号是否已经中止，中止就不用再花一次网络往返去申请
      // 访问令牌——反正申请到了也发不出消息，全部记 aborted 更诚实，也更省预算。
      if (signal?.aborted) {
        results = items.map(() => ({
          status: "skipped",
          reason: "aborted",
          sent: 0,
          failed: deviceCount,
          unregistered: 0,
          codes: deviceCount > 0 ? { aborted: deviceCount } : {},
        }));
      } else {
        let accessToken: string | null = null;
        try {
          accessToken = await getAccessToken(sa, now, signal);
        } catch (err) {
          if (!(err instanceof FcmAuthError)) throw err;
        }
        if (accessToken === null) {
          results = items.map(() => skippedFcmAuthFailed(deviceCount));
        } else {
          results = await runSendLoop(sa.project_id, accessToken, items, targets, decrypted, now, signal, unregisteredClears);
        }
      }
    }
  }

  if (unregisteredClears.length > 0) {
    try {
      await clearUnregisteredTokens(env, unregisteredClears);
    } catch (err) {
      // 不含 token 明文/密文：只报告失败这件事本身。
      console.error("清理已注销设备的 push token 失败", err instanceof Error ? err.message : String(err));
    }
  }
  try {
    await writePushLog(env, items, now, deviceCount, results);
  } catch (err) {
    console.error("写入 push_log 失败", err instanceof Error ? err.message : String(err));
  }

  return results;
}

/**
 * 投递一批通知：解析目标设备、取 FCM 访问令牌、串行发送、清理已注销的令牌、写 push_log。
 * 永不抛异常——任何环节的失败都被吸收为对应的 PushOutcome / PushLogResult，D1 写失败只
 * console.error，不影响返回值。
 */
export async function deliver(
  env: Env,
  items: OutgoingPush[],
  now: Date,
  signal?: AbortSignal,
  opts: DeliverOptions = {},
): Promise<PushLogResult[]> {
  if (items.length === 0) return [];
  try {
    return await deliverInner(env, items, now, signal, opts);
  } catch (err) {
    // 真正意外的异常（例如 D1 查询本身抛错）：绝不向上抛出，退化为「跳过」，不写 push_log
    // （连目标设备数都不确定，写不出有意义的一行），只留下日志线索，且日志里不含敏感数据。
    console.error("push deliver 遇到意外异常，已降级为 skipped", err instanceof Error ? err.message : String(err));
    // T5.6 修复 2：这类兜底异常也要有非空 reason（[gate] P5 抽查补的 "internal"），
    // 不能让 status === "skipped" 却 reason === null 溜出去。
    return items.map(() => ({ status: "skipped", reason: "internal", sent: 0, failed: 0, unregistered: 0, codes: {} }));
  }
}
