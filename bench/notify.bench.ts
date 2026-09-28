// notify 任务「一轮评估」的基准：selectInputs（挑有效快照）+ 四个策略各自的 evaluate +
// serializeState。这部分是纯函数，直接调用 src 里导出的真实实现；不经过 D1（读快照 /
// 读写 notify_state 是 I/O，本卡不测那部分），输入是手写的、形状与 contract/dashboard.ts
// 一致的最小样本（notify 任务没有专门的 test/fixtures 录制文件，输入本身就是内部状态，
// 不是「外部响应」，因此不适用「必须来自 test/fixtures」这条——四个任务各自的外部响应
// 解析已经在 jobs.bench.ts 里测过）。
//
// jobs/notify.ts 的 evaluatePolicies 本身没有导出（卡上只允许改 bench/*.ts），这里按同样的
// 顺序调用 NOTIFY_POLICY_ORDER 对应的四个真实 evaluate 函数 + serializeState，等价地
// 复现「一轮评估」的计算量。
import type { FootballStatus, MatchUi, TrafficStatus, TrainStatus, WeatherStatus } from "../src/contract/dashboard";
import { NOTIFY_POLICY_ORDER } from "../src/contract/push";
import type { Settings } from "../src/contract/settings";
import { DEFAULT_SETTINGS } from "../src/contract/settings";
import { evaluate as evaluateCommute, parseCommuteDisruptionState } from "../src/domain/commute-disruption";
import { evaluate as evaluateFootball, parseFootballNotifyState } from "../src/domain/football-notify";
import { evaluate as evaluateMorning, parseMorningBriefState } from "../src/domain/morning-brief";
import { evaluate as evaluateTicket, parseTicketState } from "../src/domain/ticket";
import { resolveWindow } from "../src/domain/windows";
import { selectInputs, serializeState, type NotifySnapshots } from "../src/notify/inputs";
import { osloLocalDate } from "../src/util/time";
import { bench, type BenchResult } from "./stats";

const NOW = new Date("2026-09-08T06:30:00Z"); // Oslo 08:30，WORK 窗口内（默认 07:00–10:00）

function planLeg(disrupted: boolean) {
  return {
    line: "R14",
    depTime: "2026-09-08T08:10:00+02:00",
    arrTime: "2026-09-08T08:40:00+02:00",
    fromName: "Asker",
    toName: "Oslo S",
    delayMin: disrupted ? 12 : 0,
    cancelled: false,
    delayKnown: true,
  };
}

function trainStatus(disrupted: boolean): TrainStatus {
  const work = {
    planText: "R14 08:10 发车",
    legs: [planLeg(disrupted)],
    adviceLevel: "info" as const,
    adviceText: "",
    alternatives: [],
    oppositeText: "",
    oppositeState: "unknown" as const,
  };
  return {
    work,
    home: { ...work, legs: [planLeg(false)] },
    transfer: null,
    originStation: "Asker",
    destinationStation: "Oslo S",
    updatedAt: "2026-09-08T08:30:00+02:00",
  };
}

const weatherStatus: WeatherStatus = {
  temperature: 12.3,
  windSpeed: 3.1,
  precip1h: 0.1,
  symbolCode: "cloudy",
  tomorrowMorningTemp: 10.5,
  tomorrowSymbol: "rain",
  updatedAt: "2026-09-08T08:30:00+02:00",
  observedAt: "2026-09-08T08:00:00+02:00",
  locationKey: "Asker torg 1, 1384 Asker",
  daily: [],
};

const trafficStatus: TrafficStatus = {
  durationSec: 1800,
  staticDurationSec: 1500,
  delaySec: 300,
  distanceMeters: 15200,
  level: "MODERATE",
  origin: "Asker torg 1, 1384 Asker",
  destination: "Karl Johans gate 1, 0154 Oslo",
  updatedAt: "2026-09-08T08:30:00+02:00",
};

const upcomingMatch: MatchUi = {
  idEvent: "4300001",
  timestamp: "2026-09-08T19:00:00Z",
  title: "Real Madrid CF vs Real Betis Balompié",
  league: "Primera Division",
  homeTeam: "Real Madrid CF",
  awayTeam: "Real Betis Balompié",
  homeScore: null,
  awayScore: null,
  status: "TIMED",
  homeBadge: null,
  awayBadge: null,
  venue: null,
  isHome: true,
};

const footballStatus: FootballStatus = {
  nextMatches: [upcomingMatch],
  lastMatches: [],
  updatedAt: "2026-09-08T08:30:00Z",
  league: null,
};

const NOTIFY_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  notifyCommuteDisruption: true,
  notifyMorningBrief: true,
  notifyFootballMatch: true,
  notifyTicketExpiry: true,
  transitPassUntil: "2026-09-09T23:59",
  parkingPassUntil: "",
};

function snapshots(): NotifySnapshots {
  const base = { error: null };
  return {
    train: { ...base, state: "ok", data: trainStatus(true), fetchedAt: NOW.toISOString(), observedAt: NOW.toISOString() },
    weather: { ...base, state: "ok", data: weatherStatus, fetchedAt: NOW.toISOString(), observedAt: NOW.toISOString() },
    traffic_outbound: { ...base, state: "ok", data: trafficStatus, fetchedAt: NOW.toISOString(), observedAt: NOW.toISOString() },
    football: { ...base, state: "ok", data: footballStatus, fetchedAt: NOW.toISOString(), observedAt: NOW.toISOString() },
  };
}

/** 与 jobs/notify.ts 的 evaluatePolicies 同一套调用序列（该函数本身未导出，见文件顶部说明）。 */
function evaluateOneRound(): void {
  const snaps = snapshots();
  const inputs = selectInputs(snaps, NOTIFY_SETTINGS, NOW);
  const window = resolveWindow(NOW, NOTIFY_SETTINGS);
  const today = osloLocalDate(NOW);

  for (const policy of NOTIFY_POLICY_ORDER) {
    if (policy === "morning_brief") {
      if (inputs.morning === "skip" || inputs.morning === "defer") continue;
      const prev = parseMorningBriefState(null);
      const decision = evaluateMorning(inputs.morning.weather, inputs.morning.train, inputs.morning.traffic, window, today, prev.lastSentDate);
      serializeState("morning_brief", { lastSentDate: decision.newLastSentDate });
      continue;
    }
    if (policy === "commute_disruption") {
      if (inputs.commute === null) continue;
      const prev = parseCommuteDisruptionState(null);
      const decision = evaluateCommute(inputs.commute, window, prev.fingerprint);
      serializeState("commute_disruption", { fingerprint: decision.newFingerprint });
      continue;
    }
    if (policy === "football") {
      if (inputs.football === null) continue;
      const prev = parseFootballNotifyState(null);
      const decision = evaluateFootball(inputs.football, NOW, prev);
      serializeState("football", decision.newState);
      continue;
    }
    if (policy === "ticket") {
      const prev = parseTicketState(null);
      const decision = evaluateTicket(NOTIFY_SETTINGS, NOW, prev);
      serializeState("ticket", { keys: decision.newKeys });
      continue;
    }
  }
}

export async function runNotifyBench(): Promise<BenchResult> {
  return bench("notify 一轮评估（四个策略）", { iterations: 500, warmup: 5 }, () => {}, () => evaluateOneRound());
}
