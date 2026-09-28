// 从 app/.../data/train/TrainRepository.kt 移植：给定 now/settings/外部数据 → TrainStatus
// 的纯计算。I/O（Entur 请求、快照写入）留给 jobs/train.ts；这里的三个外部依赖（fetchBoth /
// fastestTrip / fetchStop）由调用方注入（见 TrainSources），方便金标准测试用查表假实现。
import type { Settings } from "../contract/settings";
import type { PlanLeg, TrainPlan, TrainStatus } from "../contract/dashboard";
import { planAdvise } from "./advice";
import { L1_STATIONS, resolveStations, type L1Station } from "./l1-stations";
import { oppositeInfo } from "./opposite";
import { matches } from "./station-matcher";
import { buildTransferBoard, TRANSFER_STATION, type TransferBoard } from "./transfer";
import { resolveWindow } from "./windows";
import type { StopDeparture, TripItinerary, TripRailLeg } from "../sources/entur";
import { delayMinutes, formatIsoHm, minutesBetween, osloIsoOffset, parseIso } from "../util/time";

export interface TrainSources {
  fetchBoth(originId: string, destId: string, from: Date): Promise<[StopDeparture[], StopDeparture[]]>;
  fastestTrip(fromId: string, toId: string, at: Date): Promise<TripItinerary | null>;
  fetchStop(stopId: string, from: Date): Promise<StopDeparture[]>;
}

/** 与 Kotlin `TrainRepository.realtimeKnown` 一致：有实时数据或已取消都算「已知」。 */
function realtimeKnown(c: StopDeparture): boolean {
  return c.realtime || c.cancellation;
}

function arrivalAt(c: StopDeparture, stationName: string): Date | null {
  const call = (c.serviceJourney?.estimatedCalls ?? []).find((ec) => matches(ec.quay?.name, stationName));
  if (call == null) return null;
  return parseIso(call.expectedArrivalTime ?? call.aimedArrivalTime);
}

/** 班次按「出发站 → 到达站」的顺序经过，用于判断行驶方向。 */
function servesInOrder(c: StopDeparture, fromName: string, toName: string): boolean {
  const calls = c.serviceJourney?.estimatedCalls ?? [];
  const fromIdx = calls.findIndex((ec) => matches(ec.quay?.name, fromName));
  const toIdx = calls.findIndex((ec) => matches(ec.quay?.name, toName));
  return fromIdx >= 0 && toIdx > fromIdx;
}

/**
 * 在车站时刻表中查找与行程段同线路、发车时间相近（±3 分钟，向零截断的分钟数）的班次；
 * 窗口内有多个候选时取时间最接近的一个，并列取列表中先出现的（Kotlin `minByOrNull` 语义，
 * 这里用严格小于比较保持一致）。找不到发车侧匹配再按到达时间匹配（跨站，如 R14 在 Sandvika
 * 时刻表中按 Asker 出发时刻查找）。
 */
function findCall(leg: TripRailLeg, calls: StopDeparture[]): StopDeparture | null {
  function closest(key: (c: StopDeparture) => Date | null): StopDeparture | null {
    let best: StopDeparture | null = null;
    let bestDiff = Infinity;
    for (const c of calls) {
      if ((c.serviceJourney?.journeyPattern?.line?.publicCode ?? null) !== leg.line) continue;
      if (!servesInOrder(c, leg.fromName, leg.toName)) continue;
      const t = key(c);
      if (t == null) continue;
      const diff = Math.abs(minutesBetween(t, leg.depTime));
      if (diff > 3) continue;
      if (diff < bestDiff) {
        bestDiff = diff;
        best = c;
      }
    }
    return best;
  }

  return (
    closest((c) => parseIso(c.expectedDepartureTime ?? c.aimedDepartureTime)) ??
    closest((c) => arrivalAt(c, leg.fromName))
  );
}

const STASJON_SUFFIX = / stasjon/g;

/** 由行程段 +（可空）匹配到的班次生成 PlanLeg。 */
function planLegFrom(leg: TripRailLeg, call: StopDeparture | null): PlanLeg {
  const fromName = leg.fromName.replace(STASJON_SUFFIX, "");
  const toName = leg.toName.replace(STASJON_SUFFIX, "");

  if (call == null) {
    const arrTime = leg.arrTime.getTime() >= leg.depTime.getTime() ? osloIsoOffset(leg.arrTime) : "";
    return {
      line: leg.line,
      depTime: osloIsoOffset(leg.depTime),
      arrTime,
      fromName,
      toName,
      delayMin: 0,
      cancelled: false,
      delayKnown: false,
    };
  }

  // 匹配到实时班次时，用实时时刻（延误/早发）替代行程规划器的计划时刻，避免
  // “芯片显示延误 10 分、正文还是原定发车时间”的误导。
  const dep = parseIso(call.expectedDepartureTime ?? call.aimedDepartureTime) ?? leg.depTime;
  const realtimeArr = arrivalAt(call, leg.toName);
  const arr =
    realtimeArr != null && realtimeArr.getTime() >= dep.getTime()
      ? realtimeArr
      : leg.arrTime.getTime() >= dep.getTime()
        ? leg.arrTime
        : null;
  return {
    line: leg.line,
    depTime: osloIsoOffset(dep),
    arrTime: arr != null ? osloIsoOffset(arr) : "",
    fromName,
    toName,
    delayMin: delayMinutes(call.aimedDepartureTime, call.expectedDepartureTime) ?? 0,
    cancelled: call.cancellation,
    delayKnown: realtimeKnown(call),
  };
}

function planLeg(c: StopDeparture, viaName: string, fromName: string, toName: string, now: Date): PlanLeg {
  const dep = parseIso(c.expectedDepartureTime ?? c.aimedDepartureTime) ?? now;
  const arrRaw = arrivalAt(c, viaName);
  const arr = arrRaw != null && arrRaw.getTime() >= dep.getTime() ? arrRaw : null;
  return {
    line: c.serviceJourney?.journeyPattern?.line?.publicCode ?? "",
    depTime: osloIsoOffset(dep),
    arrTime: arr != null ? osloIsoOffset(arr) : "",
    fromName,
    toName,
    delayMin: delayMinutes(c.aimedDepartureTime, c.expectedDepartureTime) ?? 0,
    cancelled: c.cancellation,
    delayKnown: realtimeKnown(c),
  };
}

/** 最近一班经 viaName 的 L1（严格 !isBefore(now) 含 now 本身）。 */
function nearestL1Via(calls: StopDeparture[], viaName: string, now: Date): StopDeparture | null {
  let best: StopDeparture | null = null;
  let bestDep: Date | null = null;
  for (const call of calls) {
    if ((call.serviceJourney?.journeyPattern?.line?.publicCode ?? null) !== "L1") continue;
    const dep = parseIso(call.expectedDepartureTime ?? call.aimedDepartureTime);
    if (dep == null) continue;
    const viaArrival = arrivalAt(call, viaName);
    if (viaArrival == null || viaArrival.getTime() < dep.getTime()) continue;
    if (dep.getTime() < now.getTime()) continue;
    if (bestDep == null || dep.getTime() < bestDep.getTime()) {
      best = call;
      bestDep = dep;
    }
  }
  return best;
}

/** 备选班次：严格晚于 after+2 分钟、按列表原始顺序，最多 3 条，已取消的排除。 */
function nextTrains(calls: StopDeparture[], viaName: string, after: Date): string[] {
  const afterDep = new Date(after.getTime() + 2 * 60_000);
  const result: string[] = [];
  for (const c of calls) {
    if (result.length >= 3) break;
    if ((c.serviceJourney?.journeyPattern?.line?.publicCode ?? null) !== "L1") continue;
    if (c.cancellation) continue;
    const dep = parseIso(c.expectedDepartureTime ?? c.aimedDepartureTime);
    if (dep == null) continue;
    const arr = arrivalAt(c, viaName);
    if (arr == null || arr.getTime() < dep.getTime()) continue;
    if (!(dep.getTime() > afterDep.getTime())) continue;
    result.push(fmt(c));
  }
  return result;
}

function fmt(c: StopDeparture): string {
  const rawLine = c.serviceJourney?.journeyPattern?.line?.publicCode ?? "";
  const line = rawLine.trim() === "" ? "L1" : rawLine;
  const dep = formatIsoHm(c.expectedDepartureTime ?? c.aimedDepartureTime);
  const delay = delayMinutes(c.aimedDepartureTime, c.expectedDepartureTime) ?? 0;
  const dest = c.destinationDisplay?.frontText ?? "";
  const cancel = c.cancellation ? "（已取消）" : "";
  return `${line} ${dep} 开往${dest}${delay > 0 ? `（延误 ${delay} 分钟）` : ""}${cancel}`;
}

function fmtDirect(leg: PlanLeg): string {
  return `${leg.line} ${formatIsoHm(leg.depTime)} 发车`;
}

function fmtTransfer(legs: PlanLeg[]): string {
  const firstDep = parseIso(legs[0]?.depTime);
  const lastArr = parseIso(legs[legs.length - 1]?.arrTime);
  const total = firstDep != null && lastArr != null && lastArr.getTime() >= firstDep.getTime()
    ? minutesBetween(firstDep, lastArr)
    : null;
  const parts = legs
    .map((leg) => {
      const arrival = leg.arrTime.trim() !== "" ? formatIsoHm(leg.arrTime) : "--:--";
      return `${leg.line} ${formatIsoHm(leg.depTime)} ${leg.fromName} → ${arrival} ${leg.toName}`;
    })
    .join("，换乘");
  return total != null ? `${parts}（全程 ${total} 分钟）` : parts;
}

/** 上班方向（直达或规划失败时）：最近一班经目的站的 L1。 */
function buildWorkDirect(calls: StopDeparture[], originName: string, destName: string, now: Date): TrainPlan {
  const train = nearestL1Via(calls, destName, now);
  const legs = train ? [planLeg(train, destName, originName, destName, now)] : [];
  const alts = nextTrains(calls, destName, now);
  const advice = planAdvise(legs, destName, alts);
  const opposite = oppositeInfo(calls, train);
  return {
    planText: legs[0] ? fmtDirect(legs[0]) : "",
    legs,
    adviceLevel: advice.level,
    adviceText: advice.text,
    alternatives: alts,
    oppositeText: opposite.text,
    oppositeState: opposite.state,
  };
}

/** 回家方向：最近一班经出发站的 L1。 */
function buildNearestHome(calls: StopDeparture[], originName: string, destName: string, now: Date): TrainPlan {
  const train = nearestL1Via(calls, originName, now);
  const legs = train ? [planLeg(train, originName, destName, originName, now)] : [];
  const alts = nextTrains(calls, originName, now);
  const advice = planAdvise(legs, originName, alts);
  const opposite = oppositeInfo(calls, train);
  return {
    planText: legs[0] ? fmtDirect(legs[0]) : "",
    legs,
    adviceLevel: advice.level,
    adviceText: advice.text,
    alternatives: alts,
    oppositeText: opposite.text,
    oppositeState: opposite.state,
  };
}

/**
 * 上班方向（上班窗口内）：行程规划器给出最快方案，并匹配每段班次的实时正晚点。
 * 规划器失败（吞异常，除非是调用方的 signal 主动中止）或只有一段时退回最近一班直达。
 */
async function buildWork(
  callsA: StopDeparture[],
  callsB: StopDeparture[],
  originName: string,
  destName: string,
  now: Date,
  originId: string,
  destId: string,
  sources: TrainSources,
  signal: AbortSignal | undefined,
): Promise<TrainPlan> {
  let railLegs: TripRailLeg[] = [];
  try {
    const itinerary = await sources.fastestTrip(originId, destId, now);
    railLegs = itinerary?.railLegs ?? [];
  } catch (err) {
    if (signal?.aborted) throw err;
    railLegs = [];
  }
  if (railLegs.length < 2) {
    return buildWorkDirect(callsA, originName, destName, now);
  }
  const planLegs = railLegs.map((leg) => planLegFrom(leg, findCall(leg, callsA) ?? findCall(leg, callsB)));
  const firstLegCall = findCall(railLegs[0]!, callsA);
  const alts = nextTrains(callsA, destName, now);
  const advice = planAdvise(planLegs, destName, alts);
  const opposite = oppositeInfo(callsA, firstLegCall);
  return {
    planText: fmtTransfer(planLegs),
    legs: planLegs,
    adviceLevel: advice.level,
    adviceText: advice.text,
    alternatives: alts,
    oppositeText: opposite.text,
    oppositeState: opposite.state,
  };
}

/** 回家方向（下班窗口内）：行程规划器给出最快方案（快车到 Asker 换 L1），并匹配实时延误。 */
async function buildFastestHome(
  callsAtDestination: StopDeparture[],
  callsAtOrigin: StopDeparture[],
  originName: string,
  destName: string,
  destId: string,
  originId: string,
  now: Date,
  sources: TrainSources,
  signal: AbortSignal | undefined,
): Promise<TrainPlan> {
  let itinerary: TripItinerary | null;
  try {
    itinerary = await sources.fastestTrip(destId, originId, now);
  } catch (err) {
    if (signal?.aborted) throw err;
    itinerary = null;
  }
  if (itinerary == null || itinerary.railLegs.length === 0) {
    return buildNearestHome(callsAtDestination, originName, destName, now);
  }
  const railLegs = itinerary.railLegs;
  const planLegs = railLegs.map((leg) =>
    planLegFrom(leg, findCall(leg, callsAtDestination) ?? findCall(leg, callsAtOrigin)),
  );
  const alts = nextTrains(callsAtDestination, originName, now);
  const advice = planAdvise(planLegs, originName, alts);
  // 单线区段是 Spikkestad↔Asker 这一段，对应行程里的 L1 腿（换乘方案通常是「R14 到
  // Asker → 换 L1 到 Spikkestad」，L1 是最后一腿；找不到时退回最后一腿）。
  const l1Leg = railLegs.find((leg) => leg.line === "L1") ?? railLegs[railLegs.length - 1]!;
  const l1Call = findCall(l1Leg, callsAtOrigin) ?? findCall(l1Leg, callsAtDestination);
  const opposite = oppositeInfo(callsAtOrigin, l1Call);
  return {
    planText: railLegs.length > 1 ? fmtTransfer(planLegs) : fmtDirect(planLegs[0]!),
    legs: planLegs,
    adviceLevel: advice.level,
    adviceText: advice.text,
    alternatives: alts,
    oppositeText: opposite.text,
    oppositeState: opposite.state,
  };
}

/**
 * 上班方向换乘面板：仅当换乘站（Asker）位于出发站与到达站之间时适用。
 * 拉取换乘站班次，按 L1 到达时刻配对第一班顺向 R14。
 */
async function buildTransfer(
  origin: L1Station,
  dest: L1Station,
  callsA: StopDeparture[],
  now: Date,
  sources: TrainSources,
  signal: AbortSignal | undefined,
): Promise<TransferBoard | null> {
  const oi = L1_STATIONS.findIndex((s) => s.name === origin.name);
  const di = L1_STATIONS.findIndex((s) => s.name === dest.name);
  const ti = L1_STATIONS.findIndex((s) => s.name === TRANSFER_STATION);
  if (oi < 0 || di < 0 || ti < 0 || !(oi < ti && ti < di)) return null;
  const transfer = L1_STATIONS[ti]!;
  let callsT: StopDeparture[];
  try {
    callsT = await sources.fetchStop(transfer.stopId, new Date(now.getTime() - 45 * 60_000));
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
  return buildTransferBoard(callsA, callsT, origin.name, dest.name, now);
}

/**
 * 给定 now/settings/外部数据源，算出完整的 TrainStatus（对应 Kotlin
 * `TrainRepository.refresh`）。fetchBoth 的异常向上抛（由 jobs/train.ts 归为刷新失败）；
 * fastestTrip / fetchStop 的异常吞掉并退回直达/无换乘面板，除非 signal 已被主动中止
 * （与 T3.7 F2 的 traffic 做法一致：调度取消不能被当成普通的上游故障悄悄吞掉）。
 *
 * [gate] P9：出发站或到达站在 L1 站表里找不到（含空串）时抛出「请先在设置里选择车站」，
 * 不发任何请求——与 Kotlin `TrainRepository.refresh` 一致（CONTRACT 第 9 节）。
 */
export async function buildTrainStatus(
  now: Date,
  settings: Settings,
  sources: TrainSources,
  signal?: AbortSignal,
): Promise<TrainStatus> {
  const resolved = resolveStations(settings);
  if (resolved === null) {
    throw new Error("请先在设置里选择车站");
  }
  const { origin, dest } = resolved;
  const window = resolveWindow(now, settings);

  const from = new Date(now.getTime() - 45 * 60_000);
  const [a, b] = await sources.fetchBoth(origin.stopId, dest.stopId, from);

  const work =
    window === "OUTSIDE"
      ? buildWorkDirect(a, origin.name, dest.name, now)
      : await buildWork(a, b, origin.name, dest.name, now, origin.stopId, dest.stopId, sources, signal);

  const home =
    window === "RETURN"
      ? await buildFastestHome(b, a, origin.name, dest.name, dest.stopId, origin.stopId, now, sources, signal)
      : buildNearestHome(b, origin.name, dest.name, now);

  const transfer = window === "WORK" ? await buildTransfer(origin, dest, a, now, sources, signal) : null;

  return {
    work,
    home,
    transfer,
    originStation: origin.name,
    destinationStation: dest.name,
    updatedAt: osloIsoOffset(now),
  };
}
