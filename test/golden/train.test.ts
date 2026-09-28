// 金标准：通勤建议（AdviceEngine.planAdvise）与整条 train 刷新流程（TrainRepository.refresh）。
//
// buildTrainStatus 本身是异步的（外部数据由调用方注入的 TrainSources 提供），refresh 部分
// 用 harness.ts 的 runGoldenAsync 跑（T4.6 item 3 新增）：每条用例独立 await，不再需要
// beforeAll 把结果预先按 input 对象引用存进 Map——那种写法下「意外调用」的异常会在
// beforeAll 里被抛出，让整个 describe 块的所有用例一起失败，而不是只有触发意外调用的
// 那一条用例失败。
import adviceEnginePlanAdvise from "../../../contracts/golden/advice-engine.plan-advise.json";
import trainRepositoryRefresh from "../../../contracts/golden/train-repository.refresh.json";
import { planAdvise } from "../../src/domain/advice";
import { buildTrainStatus, type TrainSources } from "../../src/domain/train";
import type { PlanLeg, TrainStatus } from "../../src/contract/dashboard";
import { SettingsSchema } from "../../src/contract/settings";
import { StopDepartureSchema } from "../../src/sources/entur";
import type { TripItinerary } from "../../src/sources/entur";
import { SourceFailure } from "../../src/sources/http";
import { osloIsoOffset, parseIso } from "../../src/util/time";
import { runGolden, runGoldenAsync } from "./harness";

runGolden(adviceEnginePlanAdvise, (input) => {
  const i = input as {
    legs: Array<{ line: string; depTime: string; arrTime: string; delayKnown: boolean; delayMin?: number; cancelled?: boolean }>;
    destination: string;
    alternatives: string[];
  };
  const legs: PlanLeg[] = i.legs.map((leg) => ({
    line: leg.line,
    depTime: leg.depTime,
    arrTime: leg.arrTime,
    fromName: "",
    toName: "",
    delayMin: leg.delayMin ?? 0,
    cancelled: leg.cancelled ?? false,
    delayKnown: leg.delayKnown,
  }));
  return planAdvise(legs, i.destination, i.alternatives);
});

// ---------------------------------------------------------------------
// TrainRepository.refresh：假 sources 按 input 查表、记录调用。
// ---------------------------------------------------------------------

interface TrainRefreshInput {
  now: string;
  settings: Record<string, unknown>;
  both: { a: unknown[]; b: unknown[] } | { $error: string };
  trips: Array<{ from: string; to: string; result: unknown[] | null | { $error: string } }>;
  stops: Array<{ stopId: string; result: unknown[] | { $error: string } }>;
}

function isErrorMarker(value: unknown): value is { $error: string } {
  return typeof value === "object" && value !== null && "$error" in value;
}

interface CaseResult {
  status: TrainStatus | null;
  error: boolean;
  calls: string[];
}

async function computeCase(rawInput: unknown): Promise<CaseResult> {
  const input = rawInput as TrainRefreshInput;
  const settings = SettingsSchema.parse(input.settings ?? {});
  const now = parseIso(input.now);
  if (now == null) throw new Error(`无法解析 now：${input.now}`);

  const calls: string[] = [];
  // 查不到的请求（不在金标准的 trips/stops 表里）必须让整条用例失败，且这个失败不能被
  // buildTrainStatus 自身对 fastestTrip/fetchStop 的 try/catch 吞掉——这里先记录，
  // 等 buildTrainStatus 跑完（不管它是正常返回还是走了自己的 catch 分支）再统一断言。
  const unexpected: string[] = [];

  const sources: TrainSources = {
    async fetchBoth(originId, destId, from) {
      calls.push(`fetchBoth:${originId},${destId}@${osloIsoOffset(from)}`);
      if (isErrorMarker(input.both)) {
        throw new SourceFailure("upstream_5xx", input.both.$error);
      }
      return [
        input.both.a.map((c) => StopDepartureSchema.parse(c)),
        input.both.b.map((c) => StopDepartureSchema.parse(c)),
      ];
    },
    async fastestTrip(fromId, toId, at) {
      calls.push(`fastestTrip:${fromId}->${toId}@${osloIsoOffset(at)}`);
      const entry = input.trips.find((t) => t.from === fromId && t.to === toId);
      if (!entry) {
        unexpected.push(`意外调用 fastestTrip(${fromId}, ${toId})：不在金标准的 trips 表里`);
        throw new Error("意外调用 fastestTrip");
      }
      if (isErrorMarker(entry.result)) {
        throw new SourceFailure("upstream_5xx", entry.result.$error);
      }
      if (entry.result == null) return null;
      const railLegs: TripItinerary["railLegs"] = entry.result.map((raw) => {
        const leg = raw as { line: string; depTime: string; arrTime: string; fromName: string; toName: string };
        const dep = parseIso(leg.depTime);
        const arr = parseIso(leg.arrTime);
        if (dep == null || arr == null) {
          throw new Error(`金标准 trips[].result 里的时刻解析失败：${JSON.stringify(leg)}`);
        }
        return { line: leg.line, depTime: dep, arrTime: arr, fromName: leg.fromName, toName: leg.toName };
      });
      return { railLegs };
    },
    async fetchStop(stopId, from) {
      calls.push(`fetchStop:${stopId}@${osloIsoOffset(from)}`);
      const entry = input.stops.find((s) => s.stopId === stopId);
      if (!entry) {
        unexpected.push(`意外调用 fetchStop(${stopId})：不在金标准的 stops 表里`);
        throw new Error("意外调用 fetchStop");
      }
      if (isErrorMarker(entry.result)) {
        throw new SourceFailure("upstream_5xx", entry.result.$error);
      }
      return entry.result.map((c) => StopDepartureSchema.parse(c));
    },
  };

  let status: TrainStatus | null = null;
  let error = false;
  try {
    status = await buildTrainStatus(now, settings, sources);
  } catch {
    error = true;
  }

  if (unexpected.length > 0) {
    throw new Error(`金标准用例出现意外调用（未被 buildTrainStatus 的 try/catch 掩盖）：${unexpected.join("；")}`);
  }

  return { status, error, calls: [...calls].sort() };
}

runGoldenAsync(trainRepositoryRefresh, computeCase);
