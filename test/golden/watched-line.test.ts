// contracts/golden/watched-line.status.json 的 TS 侧运行：对应 Kotlin
// WatchedLinePolicyTest / WatchedLineGoldenTest，逐条比对 WatchedLinePolicy.status 的输出。
import watchedLineStatus from "../../../contracts/golden/watched-line.status.json";
import { status, type BusCall, type WatchedLineConfig } from "../../src/domain/watched-line";
import { runGolden } from "./harness";

interface QuayInput {
  stopPlace?: { id?: string | null } | null;
}

interface CallInput {
  realtime?: boolean;
  aimedDepartureTime?: string | null;
  expectedDepartureTime?: string | null;
  cancellation?: boolean;
  destinationDisplay?: { frontText?: string | null } | null;
  serviceJourney?: {
    journeyPattern?: { line?: { publicCode?: string | null } | null } | null;
    quays?: QuayInput[] | null;
  } | null;
}

interface ConfigInput {
  lineCode: string;
  stopA: { id: string; name: string };
  stopB: { id: string; name: string };
}

interface Input {
  config: ConfigInput;
  callsA: CallInput[];
  callsB: CallInput[];
  now: string;
}

function toBusCall(call: CallInput): BusCall {
  return {
    line: call.serviceJourney?.journeyPattern?.line?.publicCode ?? "",
    destName: call.destinationDisplay?.frontText ?? "",
    aimedDep: call.aimedDepartureTime ?? null,
    expectedDep: call.expectedDepartureTime ?? null,
    realtime: call.realtime ?? false,
    cancelled: call.cancellation ?? false,
    quayIds: (call.serviceJourney?.quays ?? [])
      .map((q) => q.stopPlace?.id)
      .filter((id): id is string => id !== null && id !== undefined),
  };
}

runGolden(watchedLineStatus, (input: Input) => {
  const config: WatchedLineConfig = input.config;
  const now = new Date(input.now);
  return status(config, input.callsA.map(toBusCall), input.callsB.map(toBusCall), now, "2026-01-01T00:00:00+01:00");
});
