// 五个任务处理器的「响应 JSON → zod 解析 → 领域计算 → 快照序列化」基准。
// D1 换成 bench/fake-d1.ts 的内存 SQLite（真实 SQL，只是没有网络往返）；fetch 换成
// bench/mock-fetch.ts，响应体一律来自 test/fixtures 的真实录制样本（bus 任务除外——
// P3 的关注线路卡片是 P9 才加的功能，test/fixtures 里没有现成文件，这里按
// test/jobs/bus.test.ts 里同样的形状手写一份最小样本，并在下方注释说明）。
import { weatherJob } from "../src/jobs/weather";
import { trafficOutboundJob } from "../src/jobs/traffic";
import { footballJob } from "../src/jobs/football";
import { trainJob } from "../src/jobs/train";
import { busJob } from "../src/jobs/bus";
import { createBenchEnv, seedSecret, seedSettings, resetRateBuckets } from "./env";
import { loadFixture } from "./fixtures";
import { jsonBodyOf, withFetch } from "./mock-fetch";
import { bench, type BenchResult } from "./stats";

const ITERATIONS = 200;

// Oslo 夏令时（CEST +2）某日 08:00，落在默认 WORK 窗口（07:00–10:00）内，
// 与 trip-rail-legs.json / departures-both-stops.json 里 2026-09-08 的时刻同一天。
const WORK_NOW = new Date("2026-09-08T06:00:00Z");

async function benchWeather(): Promise<BenchResult> {
  const { env, db } = createBenchEnv();
  seedSettings(db, { originAddress: "Asker torg 1, 1384 Asker" });
  const geocode = loadFixture("entur/geocode-asker.json");
  const met = loadFixture("met/locationforecast.json");

  return bench(
    "weather job（geocode 缓存命中后的稳态）",
    { iterations: ITERATIONS, warmup: 3 },
    () => {},
    () =>
      withFetch(
        (url) => {
          if (url.includes("geocoder")) return { body: geocode };
          if (url.includes("api.met.no")) {
            return { body: met, headers: { etag: '"bench-etag"', "last-modified": "Tue, 08 Sep 2026 12:00:00 GMT", expires: "Tue, 08 Sep 2026 12:45:00 GMT" } };
          }
          throw new Error(`weather bench: 未处理的 URL ${url}`);
        },
        () => weatherJob(env, WORK_NOW, new AbortController().signal),
      ),
  );
}

async function benchTraffic(): Promise<BenchResult> {
  const { env, db } = createBenchEnv();
  seedSettings(db, {
    originAddress: "Asker torg 1, 1384 Asker",
    destinationAddress: "Karl Johans gate 1, 0154 Oslo",
  });
  await seedSecret(db, "google_routes", "bench-fake-google-routes-key");
  const geocode = loadFixture("entur/geocode-asker.json");
  const route = loadFixture("routes/compute-ok.json");

  return bench(
    "traffic_outbound job（geocode 缓存命中后的稳态）",
    { iterations: ITERATIONS, warmup: 3 },
    () => {},
    () =>
      withFetch(
        (url) => {
          if (url.includes("geocoder")) return { body: geocode };
          if (url.includes("routes.googleapis.com")) return { body: route };
          throw new Error(`traffic bench: 未处理的 URL ${url}`);
        },
        () => trafficOutboundJob(env, WORK_NOW, new AbortController().signal),
      ),
  );
}

/**
 * football 任务：每次迭代把 now 往后推 31 分钟（超过 LEAGUE_TTL_MIN=30），强制每次都
 * 真正重新拉一次积分榜/射手榜——这是「最坏情形」（榜单也刷新）而不是最常见情形
 * （大多数分钟级 tick 只查赛程、复用 30 分钟内的旧榜单），偏保守，符合本卡「不确定
 * 就往坏了估」的原则；令牌桶在每次迭代前重置，避免连续跑几百次就把 10 个令牌耗尽
 * 导致后面全部走「令牌不足」的失败分支而不是真实的解析路径。
 */
async function benchFootball(): Promise<BenchResult> {
  const { env, db } = createBenchEnv();
  await seedSecret(db, "football_data", "bench-fake-football-data-key");
  const matches = loadFixture("football/matches.json");
  const standings = loadFixture("football/standings.json");
  const scorers = loadFixture("football/scorers.json");

  let i = 0;
  return bench(
    "football job（每次都刷新积分榜/射手榜，最坏情形）",
    { iterations: ITERATIONS, warmup: 3 },
    () => {
      resetRateBuckets(db);
      i += 1;
    },
    () =>
      withFetch(
        (url) => {
          if (url.includes("/matches")) return { body: matches };
          if (url.includes("/standings")) return { body: standings };
          if (url.includes("/scorers")) return { body: scorers };
          throw new Error(`football bench: 未处理的 URL ${url}`);
        },
        () => footballJob(env, new Date(WORK_NOW.getTime() + i * 31 * 60_000), new AbortController().signal).catch(() => {
          // 令牌不足或 EmptyWindowError 时 footballJob 会 throw（调度退避用），
          // 基准脚本只关心 CPU 耗时，吞掉这个预期内的异常。
        }),
      ),
  );
}

/** 出发/到达站选在 L1 站表里「换乘站（Asker）前后各一个」的位置，确保换乘面板那条分支也被执行到。 */
async function benchTrain(): Promise<BenchResult> {
  const { env, db } = createBenchEnv();
  seedSettings(db, { originStation: "Spikkestad", destStation: "Oslo S" });
  const departures = loadFixture("entur/departures-both-stops.json");
  const trip = loadFixture("entur/trip-rail-legs.json");

  return bench(
    "train job（含上班方向换乘面板）",
    { iterations: ITERATIONS, warmup: 3 },
    () => {},
    () =>
      withFetch(
        (url, init) => {
          const { query } = jsonBodyOf(init);
          if (query?.includes("query Trip(")) return { body: trip };
          return { body: departures }; // fetchBoth（含 stopA/stopB）与 fetchStop（只用 data.stopA）都复用这份样本
        },
        () => trainJob(env, WORK_NOW, new AbortController().signal),
      ),
  );
}

// bus（关注线路卡片）是 P9 才加的功能，test/fixtures 里没有现成的录制响应；
// 按 test/jobs/bus.test.ts 里同样的形状手写一份最小样本（不是「臆造格式」，字段与
// src/sources/entur.ts 的 WatchedLineStopDeparture schema 逐一对应，只是数据是虚构的）。
const BUS_LINE_ID = "TST:Line:42";
const BUS_LINE_CODE = "42";
const BUS_STOP_A = { id: "NSR:StopPlace:90001", name: "Alpha" };
const BUS_STOP_B = { id: "NSR:StopPlace:90002", name: "Beta" };

function busCall(minutesFromNow: number, destName: string): unknown {
  const dep = new Date(WORK_NOW.getTime() + minutesFromNow * 60_000).toISOString();
  return {
    realtime: true,
    aimedDepartureTime: dep,
    expectedDepartureTime: dep,
    cancellation: false,
    destinationDisplay: { frontText: destName },
    serviceJourney: {
      transportMode: "bus",
      journeyPattern: { line: { publicCode: BUS_LINE_CODE } },
      quays: [BUS_STOP_A.id, BUS_STOP_B.id].map((id) => ({ stopPlace: { id } })),
    },
  };
}

async function benchBus(): Promise<BenchResult> {
  const { env, db } = createBenchEnv();
  seedSettings(db, {
    watchedLineId: BUS_LINE_ID,
    watchedLineCode: BUS_LINE_CODE,
    watchedStopAId: BUS_STOP_A.id,
    watchedStopAName: BUS_STOP_A.name,
    watchedStopBId: BUS_STOP_B.id,
    watchedStopBName: BUS_STOP_B.name,
  });
  const body = {
    data: {
      stop0: { name: BUS_STOP_A.name, estimatedCalls: [busCall(5, BUS_STOP_B.name), busCall(20, BUS_STOP_B.name)] },
      stop1: { name: BUS_STOP_B.name, estimatedCalls: [busCall(8, BUS_STOP_A.name), busCall(25, BUS_STOP_A.name)] },
    },
  };

  return bench(
    "bus job（关注线路卡片）",
    { iterations: ITERATIONS, warmup: 3 },
    () => {},
    () => withFetch(() => ({ body }), () => busJob(env, WORK_NOW, new AbortController().signal)),
  );
}

export async function runJobBenches(): Promise<BenchResult[]> {
  return [await benchWeather(), await benchTraffic(), await benchFootball(), await benchTrain(), await benchBus()];
}
