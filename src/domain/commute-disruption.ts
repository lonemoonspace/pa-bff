// 从 app/.../domain/CommuteDisruptionPolicy.kt 逐行移植：判断「通勤列车异常是否该通知」。
// 只做判定；是否开启、发送与至多一次语义都是 P5 notify 任务的事，这里不碰。
import type { PlanLeg, TrainPlan, TrainStatus } from "../contract/dashboard";
import { formatIsoHm } from "../util/time";
import type { CommuteWindow } from "./windows";

export interface CommuteDisruptionDecision {
  shouldNotify: boolean;
  title: string;
  body: string;
  /** null 表示「当前没有活跃异常」；调用方应把这个值存起来作为下一次调用的 previousFingerprint。 */
  newFingerprint: string | null;
}

function planFor(status: TrainStatus, window: CommuteWindow): TrainPlan | null {
  switch (window) {
    case "WORK":
      return status.work;
    case "RETURN":
      return status.home;
    case "OUTSIDE":
      return null;
  }
}

/** 是否算「异常」：取消，或者「已知延误」且 >= 5 分钟。delayKnown 为 false 时不可信，不能拿来判定延误。 */
function isDisrupted(leg: PlanLeg): boolean {
  return leg.cancelled || (leg.delayKnown && leg.delayMin >= 5);
}

/** 延误档位：把分钟数归到「用户感受得到差别」的粒度上。 */
function delayBucket(delayMin: number): number {
  if (delayMin < 5) return 0;
  if (delayMin < 10) return 5;
  if (delayMin < 20) return 10;
  if (delayMin < 30) return 20;
  if (delayMin < 45) return 30;
  if (delayMin < 60) return 45;
  return 60;
}

/** Kotlin `substringBefore('T').ifBlank { "?" }`：无 'T' 时返回整串；整串为空/空白时返回 "?"。 */
function dayOf(depTime: string): string {
  const idx = depTime.indexOf("T");
  const day = idx === -1 ? depTime : depTime.slice(0, idx);
  return day.trim() === "" ? "?" : day;
}

/** 稳定指纹：日期 + line + 起点 + 取消状态 + 延误档位，多段之间用 "|" 连接。 */
function fingerprintOf(legs: PlanLeg[]): string {
  return legs
    .map((leg) => {
      const day = dayOf(leg.depTime);
      const delay = leg.delayKnown ? delayBucket(leg.delayMin) : -1;
      return `${day}#${leg.line}#${leg.fromName}#${leg.cancelled}#${delay}`;
    })
    .join("|");
}

function titleFor(window: CommuteWindow): string {
  switch (window) {
    case "WORK":
      return "上班列车异常";
    case "RETURN":
      return "回家列车异常";
    case "OUTSIDE":
      return "列车异常";
  }
}

/** 正文：多段之间用「；」连接。 */
function bodyFor(legs: PlanLeg[]): string {
  return legs
    .map((leg) => {
      const at = formatIsoHm(leg.depTime);
      return leg.cancelled ? `${leg.line} ${at} 已取消` : `${leg.line} ${at} 延误 ${leg.delayMin} 分钟`;
    })
    .join("；");
}

export function evaluate(
  status: TrainStatus,
  window: CommuteWindow,
  previousFingerprint: string | null,
): CommuteDisruptionDecision {
  const plan = planFor(status, window);
  if (!plan) {
    return { shouldNotify: false, title: "", body: "", newFingerprint: previousFingerprint };
  }

  const disrupted = plan.legs.filter(isDisrupted);
  if (disrupted.length === 0) {
    // 异常已恢复（或本来就没有）：清空指纹，让同一条异常再次出现时能重新通知。
    return { shouldNotify: false, title: "", body: "", newFingerprint: null };
  }

  const fingerprint = fingerprintOf(disrupted);
  if (fingerprint === previousFingerprint) {
    return { shouldNotify: false, title: "", body: "", newFingerprint: fingerprint };
  }

  return {
    shouldNotify: true,
    title: titleFor(window),
    body: bodyFor(disrupted),
    newFingerprint: fingerprint,
  };
}

/** notify_state.state_json 的外形：{ fingerprint: string | null }。 */
export interface CommuteDisruptionState {
  fingerprint: string | null;
}

/** 每次返回新对象字面量，不返回共享的模块级单例，理由同 football-notify.ts 的 initialState。 */
function initialState(): CommuteDisruptionState {
  return { fingerprint: null };
}

/**
 * 解析持久化状态；null、非法 JSON、外形不对都回退初始值。
 * 空字符串是「无活跃异常」的存储态哨兵（见 RefreshWorker.kt 对
 * AppPrefs.CACHE_TRAIN_DISRUPTION_FINGERPRINT 的写入方式），视同 null。
 */
export function parseCommuteDisruptionState(json: string | null): CommuteDisruptionState {
  if (json === null) return initialState();
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "fingerprint" in parsed &&
      (typeof (parsed as { fingerprint: unknown }).fingerprint === "string" ||
        (parsed as { fingerprint: unknown }).fingerprint === null)
    ) {
      const fingerprint = (parsed as { fingerprint: string | null }).fingerprint;
      return { fingerprint: fingerprint === "" ? null : fingerprint };
    }
    return initialState();
  } catch {
    return initialState();
  }
}
