// notify 任务：CONTRACT.md 第 6.3 节「至多一次」流程的落地。严格按顺序执行：
//   1) 读设置（四个开关全关直接返回）
//   2) 用一条 IN 查询读所需快照（只开了车票时跳过这一步）
//   3) 读全部 notify_state
//   4) 按 NOTIFY_POLICY_ORDER 评估开启且有输入的策略，state 变化才记入 changes；
//      通知在提交前就转换成 OutgoingPush（toOutgoing 对缺 matchId/kind 的通知会抛错，
//      必须在 commitStates 之前完成，绝不能让提交后的路径抛出任何异常）
//   5) commitStates；只有 RETURNING 里出现的策略才发送
//   6) deliver()（永不抛异常，仍用 try/catch 兜底——commitStates 之后不允许抛错冒出处理器，
//      否则会把调度器的失败退避也搭进来，本不该因为推送链路的故障而让状态评估重来）
import { NOTIFY_POLICY_ORDER, type NotifyPolicy } from "../contract/push";
import type { Settings } from "../contract/settings";
import { evaluate as evaluateCommute, parseCommuteDisruptionState } from "../domain/commute-disruption";
import { evaluate as evaluateFootball, parseFootballNotifyState } from "../domain/football-notify";
import { evaluate as evaluateMorning, parseMorningBriefState } from "../domain/morning-brief";
import { evaluate as evaluateTicket, parseTicketState } from "../domain/ticket";
import { resolveWindow } from "../domain/windows";
import type { Env } from "../env";
import { selectInputs, serializeState, type NotifySnapshots } from "../notify/inputs";
import { deliver, toOutgoing, type OutgoingPush } from "../notify/push";
import { commitStates, readStates, type NotifyStateChange } from "../notify/state";
import { loadSettingsOrFallback } from "../scheduler/tick";
import { configKeysFor } from "../snapshot/config-keys";
import { getMany } from "../snapshot/store";
import { osloLocalDate } from "../util/time";

/** 四个开关都关时，连快照/状态都不必读——commute/morning/football 需要快照，ticket 只看设置。 */
function needsSnapshots(settings: Settings): boolean {
  return settings.notifyCommuteDisruption || settings.notifyMorningBrief || settings.notifyFootballMatch;
}

function anySwitchOn(settings: Settings): boolean {
  return (
    settings.notifyCommuteDisruption ||
    settings.notifyMorningBrief ||
    settings.notifyFootballMatch ||
    settings.notifyTicketExpiry
  );
}

async function loadSnapshots(env: Env, settings: Settings): Promise<NotifySnapshots> {
  if (!needsSnapshots(settings)) {
    return { train: null, weather: null, traffic_outbound: null, football: null };
  }
  const keys = configKeysFor(settings);
  const many = await getMany(env, [
    { source: "train", configKey: keys.train },
    { source: "weather", configKey: keys.weather },
    { source: "traffic_outbound", configKey: keys.traffic_outbound },
    { source: "football", configKey: keys.football },
  ]);
  return {
    train: many.train ?? null,
    weather: many.weather ?? null,
    traffic_outbound: many.traffic_outbound ?? null,
    football: many.football ?? null,
  };
}

/** 第 4 步的输出：某策略若状态有变化，记入 changes；对应的通知（若有）已经是 OutgoingPush。 */
interface PolicyEvaluation {
  changes: NotifyStateChange[];
  pending: Map<NotifyPolicy, OutgoingPush[]>;
}

function evaluatePolicies(
  settings: Settings,
  now: Date,
  states: Map<NotifyPolicy, { json: string | null; version: number }>,
  inputs: ReturnType<typeof selectInputs>,
): PolicyEvaluation {
  const changes: NotifyStateChange[] = [];
  const pending = new Map<NotifyPolicy, OutgoingPush[]>();
  const window = resolveWindow(now, settings);

  for (const policy of NOTIFY_POLICY_ORDER) {
    if (policy === "morning_brief") {
      if (!settings.notifyMorningBrief) continue;
      if (inputs.morning === "skip" || inputs.morning === "defer") continue;
      const row = states.get("morning_brief");
      const prev = parseMorningBriefState(row?.json ?? null);
      const today = osloLocalDate(now);
      const decision = evaluateMorning(inputs.morning.weather, inputs.morning.train, inputs.morning.traffic, window, today, prev.lastSentDate);
      const newJson = serializeState("morning_brief", { lastSentDate: decision.newLastSentDate });
      const oldJson = serializeState("morning_brief", prev);
      if (newJson === oldJson) continue;
      changes.push({ policy: "morning_brief", json: newJson, expectedVersion: row?.version ?? 0 });
      if (decision.shouldNotify) {
        pending.set("morning_brief", [toOutgoing("morning_brief", { title: decision.title, body: decision.body })]);
      }
      continue;
    }

    if (policy === "commute_disruption") {
      if (!settings.notifyCommuteDisruption) continue;
      if (inputs.commute === null) continue;
      const row = states.get("commute_disruption");
      const prev = parseCommuteDisruptionState(row?.json ?? null);
      const decision = evaluateCommute(inputs.commute, window, prev.fingerprint);
      const newJson = serializeState("commute_disruption", { fingerprint: decision.newFingerprint });
      const oldJson = serializeState("commute_disruption", prev);
      if (newJson === oldJson) continue;
      changes.push({ policy: "commute_disruption", json: newJson, expectedVersion: row?.version ?? 0 });
      if (decision.shouldNotify) {
        pending.set("commute_disruption", [toOutgoing("commute_disruption", { title: decision.title, body: decision.body })]);
      }
      continue;
    }

    if (policy === "football") {
      if (!settings.notifyFootballMatch) continue;
      if (inputs.football === null) continue;
      const row = states.get("football");
      const prev = parseFootballNotifyState(row?.json ?? null);
      const decision = evaluateFootball(inputs.football, now, prev);
      const newJson = serializeState("football", decision.newState);
      const oldJson = serializeState("football", prev);
      if (newJson === oldJson) continue;
      changes.push({ policy: "football", json: newJson, expectedVersion: row?.version ?? 0 });
      if (decision.notifications.length > 0) {
        pending.set(
          "football",
          decision.notifications.map((n) => toOutgoing("football", { title: n.title, body: n.body, matchId: n.matchId })),
        );
      }
      continue;
    }

    if (policy === "ticket") {
      if (!settings.notifyTicketExpiry) continue;
      const row = states.get("ticket");
      const prev = parseTicketState(row?.json ?? null);
      const decision = evaluateTicket(settings, now, prev);
      const newJson = serializeState("ticket", { keys: decision.newKeys });
      const oldJson = serializeState("ticket", prev);
      if (newJson === oldJson) continue;
      changes.push({ policy: "ticket", json: newJson, expectedVersion: row?.version ?? 0 });
      if (decision.notifications.length > 0) {
        pending.set(
          "ticket",
          decision.notifications.map((n) => toOutgoing("ticket", { title: n.title, body: n.body, kind: n.kind })),
        );
      }
      continue;
    }
  }

  return { changes, pending };
}

/**
 * 处理器提交状态之后，还留给发送环节的最长时间（毫秒）。处理器整体超时是调度器的
 * 60 秒（见 scheduler/tick.ts），这里的 50 秒是更保守的软上限：commitStates 之前
 * 也会花掉一些时间，必须确保「提交后的发送」不会拖到 60 秒超时——那会触发调度退避，
 * 而此时状态其实已经提交成功，不该为了发送环节的超时又白白退避一次。
 */
const SEND_DEADLINE_MS = 50_000;

/**
 * notify 任务处理器；由 jobs/index.ts 注册为 "notify"。
 *
 * startedAt：处理器真正开始执行的墙钟时刻（区别于 `now`——`now` 是业务时间，用来算
 * 窗口、算 configKey 时效等，可能是测试里固定住的过去/未来时刻；startedAt 才是用来
 * 算「还剩多少时间可以发送」的真实时钟）。默认取调用时的 `new Date()`；测试要验证
 * 「55 秒后才提交」时，不必真的等待 55 秒——直接注入一个 55 秒前的 startedAt 即可，
 * 让下面算出的剩余时间 <= 0（T5.6 修复 4）。
 */
export async function notifyJob(env: Env, now: Date, signal: AbortSignal, startedAt: Date = new Date()): Promise<void> {
  const settings = await loadSettingsOrFallback(env, now.toISOString());
  if (!anySwitchOn(settings)) return;

  const snapshots = await loadSnapshots(env, settings);
  const inputs = selectInputs(snapshots, settings, now);
  const states = await readStates(env);

  const { changes, pending } = evaluatePolicies(settings, now, states, inputs);
  if (changes.length === 0) return;

  // 第 3 步之前的异常照常抛出（调度器退避，未发送任何东西）；commitStates 一旦成功，
  // 之后的任何异常都不得再冒出这个函数——宁可漏发一条通知，也不能让调度退避拖住下一分钟。
  const committed = await commitStates(env, changes);

  try {
    const toSend: OutgoingPush[] = [];
    for (const policy of NOTIFY_POLICY_ORDER) {
      if (!committed.has(policy)) continue;
      const items = pending.get(policy);
      if (items) toSend.push(...items);
    }
    // T5.6 修复 4：截止时间以「处理器开始 + 50 秒」为准，而不是从这一刻起再给 50 秒——
    // commitStates 之前已经花掉的时间也要算进去，否则 deliver 仍可能被拖到调度器 60
    // 秒超时那一刻才中止，届时调度器会把这次 tick 记为失败并触发退避。
    const remainingMs = SEND_DEADLINE_MS - (Date.now() - startedAt.getTime());
    const deliverSignal = remainingMs <= 0 ? AbortSignal.abort() : AbortSignal.any([signal, AbortSignal.timeout(remainingMs)]);
    await deliver(env, toSend, now, deliverSignal);
  } catch (err) {
    console.error("notify 投递遇到意外异常", err instanceof Error ? err.message : String(err));
  }
}
