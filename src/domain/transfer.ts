// 从 app/.../data/train/TransferMatcher.kt 移植。
//
// 上班方向的「L1 → R14」对比：取下一班顺向 L1，对比「坐这班 L1 直达到达站」与
// 「在换乘站（Asker）换乘其后第一班顺向 R14」谁先到达。只给出换乘等待分钟数，
// 不做换乘裕量判断（由用户自行判断是否来得及）。
//
// 方向判断不依赖线路终点文字，而是依据班次全程停靠顺序（出发站先于到达站），
// 对时刻表变更更稳健。
import { delayMinutes, minutesBetween, osloIsoOffset, parseIso } from "../util/time";
import { matches } from "./station-matcher";
import type { StopDeparture } from "../sources/entur";

export const TRANSFER_STATION = "Asker";

export interface TransferLeg {
  line: string;
  fromName: string;
  toName: string;
  depTime: string;
  arrTime: string;
  delayMin: number;
  cancelled: boolean;
  delayKnown: boolean;
}

export interface TransferOption {
  l1: TransferLeg;
  r14: TransferLeg;
  waitMin: number;
  directArrTime: string;
  savedMin: number | null;
}

export interface TransferBoard {
  transferStation: string;
  options: TransferOption[];
  updatedAt: string;
}

function dep(c: StopDeparture): Date | null {
  return parseIso(c.expectedDepartureTime ?? c.aimedDepartureTime);
}

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

export function buildTransferBoard(
  originCalls: StopDeparture[],
  transferCalls: StopDeparture[],
  originName: string,
  destName: string,
  now: Date,
): TransferBoard {
  let l1: StopDeparture | null = null;
  let l1Departure: Date | null = null;
  for (const call of originCalls) {
    if ((call.serviceJourney?.journeyPattern?.line?.publicCode ?? null) !== "L1") continue;
    if (!servesInOrder(call, originName, destName)) continue;
    const departure = dep(call);
    if (departure == null) continue;
    if (!(departure.getTime() > now.getTime())) continue;
    const transferArrival = arrivalAt(call, TRANSFER_STATION);
    if (transferArrival == null) continue;
    if (transferArrival.getTime() < departure.getTime()) continue;
    if (l1Departure == null || departure.getTime() < l1Departure.getTime()) {
      l1 = call;
      l1Departure = departure;
    }
  }

  const r14s = transferCalls
    .filter((c) => (c.serviceJourney?.journeyPattern?.line?.publicCode ?? null) === "R14")
    .filter((c) => servesInOrder(c, TRANSFER_STATION, destName))
    .filter((c) => dep(c) != null)
    .map((c) => ({ call: c, depTime: dep(c) as Date }))
    .sort((a, b) => a.depTime.getTime() - b.depTime.getTime());

  let option: TransferOption | null = null;
  if (l1 != null) {
    const l1Dep = dep(l1);
    const l1ArrTransferRaw = arrivalAt(l1, TRANSFER_STATION);
    const l1ArrTransfer =
      l1Dep != null && l1ArrTransferRaw != null && l1ArrTransferRaw.getTime() >= l1Dep.getTime()
        ? l1ArrTransferRaw
        : null;
    if (l1Dep != null && l1ArrTransfer != null) {
      const r14Entry = r14s.find(({ depTime }) => depTime.getTime() > l1ArrTransfer.getTime());
      if (r14Entry != null) {
        const r14 = r14Entry.call;
        const r14Dep = dep(r14);
        const r14ArrDestRaw = arrivalAt(r14, destName);
        const r14ArrDest =
          r14Dep != null && r14ArrDestRaw != null && r14ArrDestRaw.getTime() >= r14Dep.getTime()
            ? r14ArrDestRaw
            : null;
        if (r14Dep != null && r14ArrDest != null) {
          const l1ArrDestRaw = arrivalAt(l1, destName);
          const l1ArrDest =
            l1ArrDestRaw != null && l1ArrDestRaw.getTime() >= l1Dep.getTime() ? l1ArrDestRaw : null;
          option = {
            l1: {
              line: "L1",
              fromName: originName,
              toName: TRANSFER_STATION,
              depTime: osloIsoOffset(l1Dep),
              arrTime: osloIsoOffset(l1ArrTransfer),
              delayMin: delayMinutes(l1.aimedDepartureTime, l1.expectedDepartureTime) ?? 0,
              cancelled: l1.cancellation,
              delayKnown: realtimeKnown(l1),
            },
            r14: {
              line: "R14",
              fromName: TRANSFER_STATION,
              toName: destName,
              depTime: osloIsoOffset(r14Dep),
              arrTime: osloIsoOffset(r14ArrDest),
              delayMin: delayMinutes(r14.aimedDepartureTime, r14.expectedDepartureTime) ?? 0,
              cancelled: r14.cancellation,
              delayKnown: realtimeKnown(r14),
            },
            waitMin: Math.max(0, minutesBetween(l1ArrTransfer, r14Dep)),
            directArrTime: l1ArrDest != null ? osloIsoOffset(l1ArrDest) : "",
            savedMin: l1ArrDest != null ? minutesBetween(r14ArrDest, l1ArrDest) : null,
          };
        }
      }
    }
  }

  return {
    transferStation: TRANSFER_STATION,
    options: option != null ? [option] : [],
    updatedAt: osloIsoOffset(now),
  };
}
