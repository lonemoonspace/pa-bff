// 从 app/.../domain/OppositeTrainPolicy.kt 与
// app/.../data/train/TrainRepository.kt（oppositeInfo 部分）移植。
//
// 背景：Spikkestad ↔ Asker 是单线区段，对向列车必须在会让点交会，因此对向车的
// 延误/取消会传导到用户要坐的这班车，是决策信息而不是可有可无的提示。
import { delayMinutes, formatIsoHm, minutesBetween, parseIso } from "../util/time";
import type { StopDeparture } from "../sources/entur";

export type OppositeState = "NONE" | "ON_TIME" | "DELAYED" | "CANCELLED" | "UNKNOWN";

export interface OppositeResult {
  state: OppositeState;
  text: string;
}

/** 没有找到对向车次时的结果：不渲染。 */
export const NONE_RESULT: OppositeResult = { state: "NONE", text: "" };

/**
 * 「找到对向 L1 车次之后，怎么向用户报告」的纯判定逻辑（OppositeTrainPolicy.describe）。
 *
 * @param line 对向车次的线路代码（如 "L1"）
 * @param destination 对向车次的终到站显示文本（用于文案里的「方向」）
 * @param aimedDepartureTime 对向车次的计划发车时间（完整 ISO）
 * @param expectedDepartureTime 对向车次的实时预计发车时间；无实时数据时为 null
 * @param cancelled 对向车次是否已取消
 * @param realtimeKnown 对向车次是否有实时数据（`realtime === true` 或已取消）
 */
export function describeOpposite(
  line: string,
  destination: string,
  aimedDepartureTime: string | null,
  expectedDepartureTime: string | null,
  cancelled: boolean,
  realtimeKnown: boolean,
): OppositeResult {
  // 展示时刻优先用实时预计发车时间，与本仓库其它「对向/换乘」文案口径一致。
  const at = formatIsoHm(expectedDepartureTime ?? aimedDepartureTime);
  if (cancelled) {
    return { state: "CANCELLED", text: `对向 ${line}（${destination} 方向）${at} 已取消，单线区段可能受影响` };
  }
  // 无实时数据时不能拿 delayMinutes() 的兜底值当「正点」——那是把「不知道」
  // 误报成「安心」。必须先于延误判定单独分支出来。
  if (!realtimeKnown) {
    return { state: "UNKNOWN", text: `对向 ${line}（${destination} 方向）${at} 暂无实时数据，单线区段影响未知` };
  }
  const delay = delayMinutes(aimedDepartureTime, expectedDepartureTime) ?? 0;
  if (delay > 0) {
    return {
      state: "DELAYED",
      text: `对向 ${line}（${destination} 方向）${at} 延误 ${delay} 分钟，单线区段可能连带延误，请预留时间`,
    };
  }
  return { state: "ON_TIME", text: `对向 ${line}（${destination} 方向）${at} 正点` };
}

/** 与 Kotlin `TrainRepository.realtimeKnown` 一致：有实时数据或已取消都算「已知」。 */
function realtimeKnown(c: StopDeparture): boolean {
  return c.realtime || c.cancellation;
}

/**
 * 对向 L1（单线区段影响提示）。选取逻辑：同线路、发车方向不同（目的地文本不同）
 * 的班次里，按计划发车时间与本方向班次最接近的一个；并列时取列表中先出现的
 * （Kotlin `minByOrNull` 语义，这里用严格小于比较保持一致）。
 */
export function oppositeInfo(calls: StopDeparture[], train: StopDeparture | null): OppositeResult {
  if (train == null) return NONE_RESULT;
  const line = train.serviceJourney?.journeyPattern?.line?.publicCode ?? "";
  const dest = train.destinationDisplay?.frontText ?? "";
  const aimed = parseIso(train.aimedDepartureTime);
  if (aimed == null) return NONE_RESULT;
  if (line.trim() === "" || dest.trim() === "") return NONE_RESULT;

  let best: { call: StopDeparture; aimedTime: Date } | null = null;
  let bestDiff = Infinity;
  for (const call of calls) {
    if ((call.serviceJourney?.journeyPattern?.line?.publicCode ?? null) !== line) continue;
    const aimedTime = parseIso(call.aimedDepartureTime);
    if (aimedTime == null) continue;
    const frontText = call.destinationDisplay?.frontText ?? "";
    if (frontText === dest || frontText.trim() === "") continue;
    const diff = Math.abs(minutesBetween(aimedTime, aimed));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = { call, aimedTime };
    }
  }
  if (best == null) return NONE_RESULT;
  const opp = best.call;
  return describeOpposite(
    opp.serviceJourney?.journeyPattern?.line?.publicCode ?? "",
    opp.destinationDisplay?.frontText ?? "",
    opp.aimedDepartureTime,
    opp.expectedDepartureTime,
    opp.cancellation,
    realtimeKnown(opp),
  );
}
