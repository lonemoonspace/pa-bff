// 金标准：站名匹配、换乘面板、对向车判定，逐字符对齐 Kotlin 端的输出。
import stationMatcher from "../../../contracts/golden/station-matcher.json";
import transferMatcherBuild from "../../../contracts/golden/transfer-matcher.build.json";
import oppositeTrainPolicyDescribe from "../../../contracts/golden/opposite-train-policy.describe.json";
import trainRepositoryOppositeInfo from "../../../contracts/golden/train-repository.opposite-info.json";
import { matches, normalize } from "../../src/domain/station-matcher";
import { buildTransferBoard } from "../../src/domain/transfer";
import { describeOpposite, oppositeInfo } from "../../src/domain/opposite";
import { StopDepartureSchema, type StopDeparture } from "../../src/sources/entur";
import { parseIso } from "../../src/util/time";
import { runGolden } from "./harness";

runGolden(stationMatcher, (input) => {
  const i = input as { fn: "matches" | "normalize"; actual?: string | null; expected?: string; value?: string };
  if (i.fn === "matches") {
    return matches(i.actual ?? null, i.expected as string);
  }
  return normalize(i.value as string);
});

runGolden(transferMatcherBuild, (input) => {
  const i = input as {
    originCalls: unknown[];
    transferCalls: unknown[];
    originName: string;
    destName: string;
    now: string;
  };
  const originCalls = i.originCalls.map((c) => StopDepartureSchema.parse(c)) as StopDeparture[];
  const transferCalls = i.transferCalls.map((c) => StopDepartureSchema.parse(c)) as StopDeparture[];
  const now = parseIso(i.now);
  if (!now) throw new Error(`无法解析 now: ${i.now}`);
  return buildTransferBoard(originCalls, transferCalls, i.originName, i.destName, now);
});

runGolden(oppositeTrainPolicyDescribe, (input) => {
  const i = input as {
    line: string;
    destination: string;
    aimedDepartureTime: string | null;
    expectedDepartureTime: string | null;
    cancelled: boolean;
    realtimeKnown: boolean;
  };
  return describeOpposite(
    i.line,
    i.destination,
    i.aimedDepartureTime,
    i.expectedDepartureTime,
    i.cancelled,
    i.realtimeKnown,
  );
});

runGolden(trainRepositoryOppositeInfo, (input) => {
  const i = input as { calls: unknown[]; trainIndex: number | null };
  const calls = i.calls.map((c) => StopDepartureSchema.parse(c)) as StopDeparture[];
  const train = i.trainIndex == null ? null : calls[i.trainIndex];
  return oppositeInfo(calls, train ?? null);
});
