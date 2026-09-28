// 从 app/.../domain/AdviceEngine.kt 逐行移植：给一组行程段生成建议等级与文案。
import type { PlanLeg } from "../contract/dashboard";
import { formatIsoHm, minutesBetween, parseIso } from "../util/time";

export interface AdviceResult {
  level: string;
  text: string;
}

/**
 * 对一组行程段生成建议：
 * - 空 → UNKNOWN
 * - 任一取消 → BAD
 * - 到达时间缺失/早于出发（数据异常）→ UNKNOWN
 * - 已知延误 → WARN
 * - 实时信息缺失 → UNKNOWN
 * - 多段（换乘）→ GOOD，注明全程时长与换乘次数
 * - 单段 → GOOD，正点文案
 */
export function planAdvise(legs: PlanLeg[], destination: string, alternatives: string[]): AdviceResult {
  if (legs.length === 0) {
    const alts = alternatives.join("；");
    return { level: "UNKNOWN", text: `未找到班次。${alts !== "" ? `建议班次：${alts}` : "请稍后刷新重试"}` };
  }

  const cancelled = legs.find((leg) => leg.cancelled);
  if (cancelled) {
    const head = `${cancelled.line} ${formatIsoHm(cancelled.depTime)} 已取消！`;
    return {
      level: "BAD",
      text: alternatives.length === 0 ? `${head}暂无可改乘班次` : `${head}建议改乘：${alternatives.join("；")}`,
    };
  }

  const arrivalUnknown = legs.some((leg) => {
    if (leg.arrTime.trim() === "") return true;
    const arr = parseIso(leg.arrTime);
    if (arr == null) return true;
    const dep = parseIso(leg.depTime);
    return dep != null && arr.getTime() < dep.getTime();
  });
  if (arrivalUnknown) {
    return { level: "UNKNOWN", text: "到达时间未知或数据异常，暂无法确认预计到达时间；请以 Entur 最新信息为准" };
  }

  const delayed = legs.filter((leg) => leg.delayKnown && leg.delayMin > 0);
  if (delayed.length > 0) {
    const detail = delayed.map((leg) => `${leg.line} 延误 ${leg.delayMin} 分钟`).join("、");
    const text =
      legs.length > 1
        ? `最快方案中 ${detail}，换乘可能受影响，请留意实时信息`
        : `${detail}，预计 ${formatIsoHm(legs[0]!.arrTime)} 到 ${destination}`;
    return { level: "WARN", text };
  }

  const unknown = legs.some((leg) => !leg.delayKnown);
  if (unknown) {
    return { level: "UNKNOWN", text: "实时信息未知，暂无法确认是否正点；请以车站广播和 Entur 最新信息为准" };
  }

  if (legs.length > 1) {
    const dep = parseIso(legs[0]!.depTime);
    const arr = parseIso(legs[legs.length - 1]!.arrTime);
    const total = dep != null && arr != null ? Math.max(0, minutesBetween(dep, arr)) : 0;
    let text = "最快方案（实时时刻）";
    if (total > 0) text += `，全程约 ${total} 分钟`;
    text += `，含 ${legs.length - 1} 次换乘`;
    return { level: "GOOD", text };
  }

  const leg = legs[0]!;
  return {
    level: "GOOD",
    text: `正点！${leg.line} ${formatIsoHm(leg.depTime)} 发车，预计 ${formatIsoHm(leg.arrTime)} 到 ${destination}`,
  };
}
