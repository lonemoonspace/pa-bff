// 金标准：CommuteDisruptionPolicy.evaluate / MorningBriefPolicy.evaluate /
// FootballNotifyPolicy.evaluate / WeatherSymbols.toZh，逐字符对齐 Kotlin 端的输出。
import commuteDisruptionEvaluate from "../../../contracts/golden/commute-disruption-policy.evaluate.json";
import footballNotifyEvaluate from "../../../contracts/golden/football-notify-policy.evaluate.json";
import morningBriefEvaluate from "../../../contracts/golden/morning-brief-policy.evaluate.json";
import weatherSymbolsToZh from "../../../contracts/golden/weather-symbols.to-zh.json";
import type { PlanLeg, TrafficStatus, TrainPlan, TrainStatus, WeatherStatus } from "../../src/contract/dashboard";
import { PlanLegSchema, TrafficStatusSchema, WeatherStatusSchema } from "../../src/contract/dashboard";
import { evaluate as evaluateCommuteDisruption } from "../../src/domain/commute-disruption";
import type { NotifiedState } from "../../src/domain/football-notify";
import { evaluate as evaluateFootballNotify } from "../../src/domain/football-notify";
import { evaluate as evaluateMorningBrief } from "../../src/domain/morning-brief";
import type { CommuteWindow } from "../../src/domain/windows";
import { toZh } from "../../src/domain/weather-symbols";
import { parseIso } from "../../src/util/time";
import { runGolden } from "./harness";

function requireDate(iso: string): Date {
  const parsed = parseIso(iso);
  if (!parsed) throw new Error(`无法解析 now: ${iso}`);
  return parsed;
}

function parsePlan(raw: unknown): TrainPlan {
  const obj = (raw ?? {}) as { legs?: unknown[] };
  const legs: PlanLeg[] = (obj.legs ?? []).map((leg) => PlanLegSchema.parse(leg));
  return {
    planText: "",
    legs,
    adviceLevel: "UNKNOWN",
    adviceText: "",
    alternatives: [],
    oppositeText: "",
    oppositeState: "NONE",
  };
}

interface CommuteDisruptionInput {
  status: { work?: unknown; home?: unknown };
  window: CommuteWindow;
  previousFingerprint: string | null;
}

runGolden(commuteDisruptionEvaluate, (input) => {
  const { status, window, previousFingerprint } = input as CommuteDisruptionInput;
  const trainStatus: TrainStatus = {
    work: parsePlan(status.work),
    home: parsePlan(status.home),
    transfer: null,
    updatedAt: "",
    originStation: "",
    destinationStation: "",
  };
  return evaluateCommuteDisruption(trainStatus, window, previousFingerprint);
});

interface MorningBriefInput {
  weather: WeatherStatus | null;
  train: { work?: unknown } | null;
  traffic: TrafficStatus | null;
  window: CommuteWindow;
  today: string;
  lastSentDate: string | null;
}

runGolden(morningBriefEvaluate, (input) => {
  const { weather, train, traffic, window, today, lastSentDate } = input as MorningBriefInput;
  const weatherStatus = weather ? WeatherStatusSchema.parse(weather) : null;
  const trafficStatus = traffic ? TrafficStatusSchema.parse(traffic) : null;
  const trainStatus: TrainStatus | null = train
    ? {
        work: parsePlan(train.work),
        home: parsePlan(undefined),
        transfer: null,
        updatedAt: "",
        originStation: "",
        destinationStation: "",
      }
    : null;
  return evaluateMorningBrief(weatherStatus, trainStatus, trafficStatus, window, today, lastSentDate);
});

interface FootballNotifyInput {
  status: {
    nextMatches?: unknown[];
    lastMatches?: unknown[];
  } | null;
  now: string;
  previous: NotifiedState;
}

runGolden(footballNotifyEvaluate, (input) => {
  const { status, now, previous } = input as FootballNotifyInput;
  const footballStatus = status
    ? {
        nextMatches: (status.nextMatches ?? []).map((m) => matchUiFrom(m)),
        lastMatches: (status.lastMatches ?? []).map((m) => matchUiFrom(m)),
        updatedAt: "",
        league: null,
      }
    : null;
  return evaluateFootballNotify(footballStatus, requireDate(now), previous);
});

function matchUiFrom(raw: unknown) {
  const m = raw as {
    idEvent?: string;
    timestamp?: string;
    title?: string;
    league?: string;
    homeTeam?: string;
    awayTeam?: string;
    homeScore?: number | null;
    awayScore?: number | null;
    status?: string;
    homeBadge?: string | null;
    awayBadge?: string | null;
    venue?: string | null;
    isHome?: boolean;
  };
  return {
    idEvent: m.idEvent ?? "",
    timestamp: m.timestamp ?? "",
    title: m.title ?? "",
    league: m.league ?? "",
    homeTeam: m.homeTeam ?? "",
    awayTeam: m.awayTeam ?? "",
    homeScore: m.homeScore ?? null,
    awayScore: m.awayScore ?? null,
    status: m.status ?? "",
    homeBadge: m.homeBadge ?? null,
    awayBadge: m.awayBadge ?? null,
    venue: m.venue ?? null,
    isHome: m.isHome ?? false,
  };
}

runGolden(weatherSymbolsToZh, (input) => {
  const { code } = input as { code: string };
  return toZh(code);
});
