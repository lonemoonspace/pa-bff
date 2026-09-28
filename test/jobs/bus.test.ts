// bus 任务的集成测试（fetchMock，D1 是真的）。领域逻辑本身已由 test/golden/watched-line.test.ts
// 与 test/domain/watched-line.test.ts 逐条对照 Kotlin 覆盖，这里只测 I/O 层：未配置时不
// 发请求、已配置时请求构造（whiteListed 单条线路、serviceJourney.quays）、快照写入、
// configKey 换线路/换站后旧快照不可见。测试数据用虚构线路 TST:Line:42 与虚构站
// NSR:StopPlace:9000x（P9 通用约定）。
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { busJob } from "../../src/jobs/bus";
import { getSettingsRecord, putSettings } from "../../src/config/store";
import { get as getSnapshot } from "../../src/snapshot/store";
import { osloIsoOffset } from "../../src/util/time";
import type { Settings } from "../../src/contract/settings";

const LINE_ID = "TST:Line:42";
const LINE_CODE = "42";
const STOP_A_ID = "NSR:StopPlace:90001";
const STOP_A_NAME = "Alpha";
const STOP_B_ID = "NSR:StopPlace:90002";
const STOP_B_NAME = "Beta";
const CONFIG_KEY = `${LINE_ID}|${STOP_A_ID}|${STOP_B_ID}`;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function setWatchedLine(patch: Partial<Settings>): Promise<void> {
  const before = await getSettingsRecord(env);
  const result = await putSettings(env, before.revision, { ...before.settings, ...patch }, "test-setup");
  if (!result.ok) throw new Error("测试初始化失败：无法设置关注线路");
}

async function setDefaultWatchedLine(): Promise<void> {
  await setWatchedLine({
    watchedLineId: LINE_ID,
    watchedLineCode: LINE_CODE,
    watchedStopAId: STOP_A_ID,
    watchedStopAName: STOP_A_NAME,
    watchedStopBId: STOP_B_ID,
    watchedStopBName: STOP_B_NAME,
  });
}

async function clearWatchedLine(): Promise<void> {
  await setWatchedLine({
    watchedLineId: "",
    watchedLineCode: "",
    watchedStopAId: "",
    watchedStopAName: "",
    watchedStopBId: "",
    watchedStopBName: "",
  });
}

function iso(base: Date, minutesFromNow: number): string {
  return new Date(base.getTime() + minutesFromNow * 60_000).toISOString();
}

function hm(iso_: string): string {
  return osloIsoOffset(new Date(iso_)).slice(11, 16);
}

interface QuayOpt {
  id: string;
  parentId?: string;
}

interface CallOpts {
  aimed: string;
  line?: string;
  quayIds?: string[];
  quays?: QuayOpt[];
  realtime?: boolean;
  expected?: string | null;
  destName?: string;
}

function call(opts: CallOpts): unknown {
  const quays: QuayOpt[] = opts.quays ?? (opts.quayIds ?? [STOP_A_ID, STOP_B_ID]).map((id) => ({ id }));
  return {
    realtime: opts.realtime ?? true,
    aimedDepartureTime: opts.aimed,
    expectedDepartureTime: opts.expected ?? null,
    cancellation: false,
    destinationDisplay: { frontText: opts.destName ?? STOP_B_NAME },
    serviceJourney: {
      transportMode: "bus",
      journeyPattern: { line: { publicCode: opts.line ?? LINE_CODE } },
      quays: quays.map((q) => ({
        stopPlace: { id: q.id, parent: q.parentId ? { id: q.parentId } : null },
      })),
    },
  };
}

function envelope(callsA: unknown[], callsB: unknown[]): unknown {
  return {
    data: {
      stop0: { name: STOP_A_NAME, estimatedCalls: callsA },
      stop1: { name: STOP_B_NAME, estimatedCalls: callsB },
    },
  };
}

interface RecordedCall {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
}

function mockFetch(body: unknown, status = 200): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    const requestInit = init as RequestInit;
    calls.push({ url: String(url), body: JSON.parse(requestInit.body as string) });
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return calls;
}

async function rawBusRow(): Promise<{ state: string | null; errorCode: string | null } | null> {
  const row = await env.DB.prepare("SELECT state, error_json FROM snapshots WHERE source = 'bus'").first<{
    state: string | null;
    error_json: string | null;
  }>();
  if (!row) return null;
  const error = row.error_json ? (JSON.parse(row.error_json) as { code: string }) : null;
  return { state: row.state, errorCode: error?.code ?? null };
}

// ---- 未配置 ----

describe("busJob：未配置", () => {
  it("六个字段有任一为空 → not_configured，0 次请求", async () => {
    await clearWatchedLine();
    const calls = mockFetch(envelope([], []));

    await busJob(env, new Date(), new AbortController().signal);

    expect(calls).toHaveLength(0);
    const snap = await getSnapshot(env, "bus", null);
    expect(snap?.state).toBe("not_configured");
    expect(snap?.data).toBeNull();
  });
});

// ---- 请求构造 ----

describe("busJob：请求构造", () => {
  it("用 whiteListed: { lines: [lineId] } 一次查两个站点，班次带 serviceJourney.quays", async () => {
    await setDefaultWatchedLine();
    const calls = mockFetch(envelope([], []));

    await busJob(env, new Date(), new AbortController().signal);

    expect(calls).toHaveLength(1);
    const { query, variables } = calls[0]!.body;
    expect(query).toContain("whiteListed: { lines: $lines }");
    expect(query).toContain("quays { stopPlace { id parent { id } } }");
    expect(variables.lines).toEqual([LINE_ID]);
    expect(variables.stop0).toBe(STOP_A_ID);
    expect(variables.stop1).toBe(STOP_B_ID);
  });
});

// ---- 方向映射 ----

describe("busJob：方向映射", () => {
  it("站序里只到中途的区间车被排除，真正到达 B 的班次保留", async () => {
    await setDefaultWatchedLine();
    const base = new Date("2026-09-22T06:00:00.000Z");
    mockFetch(
      envelope(
        [
          call({ aimed: iso(base, 7), quayIds: [STOP_A_ID, "NSR:StopPlace:90003"] }),
          call({ aimed: iso(base, 57), quayIds: [STOP_A_ID, "NSR:StopPlace:90003", STOP_B_ID] }),
        ],
        [],
      ),
    );

    await busJob(env, base, new AbortController().signal);

    const snap = await getSnapshot(env, "bus", CONFIG_KEY);
    const status = snap?.data as {
      boards: Array<{ boardStop: string; towardStop: string; departures: Array<{ depTime: string }> }>;
    };
    const boardA = status.boards.find((b) => b.boardStop === STOP_A_NAME)!;
    expect(boardA.towardStop).toBe(STOP_B_NAME);
    expect(boardA.departures.map((d) => hm(d.depTime))).toEqual([hm(iso(base, 57))]);
  });

  it("B 站保留开往 A 的班次", async () => {
    await setDefaultWatchedLine();
    const base = new Date("2026-09-22T06:00:00.000Z");
    mockFetch(
      envelope(
        [],
        [
          call({ aimed: iso(base, 29), quayIds: [STOP_B_ID, STOP_A_ID], destName: STOP_A_NAME }),
          call({ aimed: iso(base, 89), quayIds: [STOP_B_ID, STOP_A_ID], destName: STOP_A_NAME }),
        ],
      ),
    );

    await busJob(env, base, new AbortController().signal);

    const snap = await getSnapshot(env, "bus", CONFIG_KEY);
    const status = snap?.data as { boards: Array<{ boardStop: string; towardStop: string; departures: Array<{ depTime: string }> }> };
    const boardB = status.boards.find((b) => b.boardStop === STOP_B_NAME)!;
    expect(boardB.towardStop).toBe(STOP_A_NAME);
    expect(boardB.departures.map((d) => hm(d.depTime))).toEqual([hm(iso(base, 29)), hm(iso(base, 89))]);
  });

  // [gate] P10 修正：线上现象复现——设置里存的是父站 id，Entur 站序给出带 parent 的子站，
  // 修复前这里会因为只比子站 id 而永远匹配不上，两个方向都空（CONTRACT 第 9 节「站的匹配」）。
  it("设置是父站、站序是带 parent 的子站 → 正常出班次", async () => {
    const parentAId = "NSR:StopPlace:91001";
    const parentBId = "NSR:StopPlace:91002";
    await setWatchedLine({ watchedStopAId: parentAId, watchedStopBId: parentBId });
    const base = new Date("2026-09-22T06:00:00.000Z");
    mockFetch(
      envelope(
        [
          call({
            aimed: iso(base, 57),
            quays: [
              { id: STOP_A_ID, parentId: parentAId },
              { id: STOP_B_ID, parentId: parentBId },
            ],
          }),
        ],
        [],
      ),
    );

    await busJob(env, base, new AbortController().signal);

    const configKey = `${LINE_ID}|${parentAId}|${parentBId}`;
    const snap = await getSnapshot(env, "bus", configKey);
    const status = snap?.data as {
      boards: Array<{ boardStop: string; towardStop: string; departures: Array<{ depTime: string }> }>;
    };
    const boardA = status.boards.find((b) => b.boardStop === STOP_A_NAME)!;
    expect(boardA.towardStop).toBe(STOP_B_NAME);
    expect(boardA.departures.map((d) => hm(d.depTime))).toEqual([hm(iso(base, 57))]);
  });
});

// ---- 实时状态映射 ----

describe("busJob：实时状态映射", () => {
  it("realtime delay, unknown realtime and expected-time preference all survive the mapping", async () => {
    await setDefaultWatchedLine();
    const base = new Date("2026-09-22T06:00:00.000Z");
    mockFetch(
      envelope(
        [
          call({ aimed: iso(base, 30), expected: iso(base, 34) }),
          call({ aimed: iso(base, 60), realtime: false }),
        ],
        [],
      ),
    );

    await busJob(env, base, new AbortController().signal);

    const snap = await getSnapshot(env, "bus", CONFIG_KEY);
    const status = snap?.data as { boards: Array<{ boardStop: string; departures: Array<{ depTime: string; delayMin: number; delayKnown: boolean }> }> };
    const departures = status.boards.find((b) => b.boardStop === STOP_A_NAME)!.departures;

    expect(departures.map((d) => hm(d.depTime))).toEqual([hm(iso(base, 34)), hm(iso(base, 60))]);
    expect(departures[0]!.delayMin).toBe(4);
    expect(departures[0]!.delayKnown).toBe(true);
    expect(departures[1]!.delayKnown).toBe(false);
  });
});

// ---- 快照 ----

describe("busJob：快照", () => {
  it("写入快照后 get() 能读回，两个方向都有内容", async () => {
    await setDefaultWatchedLine();
    const base = new Date("2026-09-22T06:00:00.000Z");
    mockFetch(envelope([call({ aimed: iso(base, 57) })], [call({ aimed: iso(base, 29), quayIds: [STOP_B_ID, STOP_A_ID], destName: STOP_A_NAME })]));

    await busJob(env, base, new AbortController().signal);

    const snap = await getSnapshot(env, "bus", CONFIG_KEY);
    expect(snap?.state).toBe("ok");
    const status = snap?.data as { boards: unknown[]; updatedAt: string; lineCode: string };
    expect(status.updatedAt).toBeTruthy();
    expect(status.boards).toHaveLength(2);
    expect(status.lineCode).toBe(LINE_CODE);
  });

  it("empty graphql payload yields two empty boards rather than an error", async () => {
    await setDefaultWatchedLine();
    mockFetch({ data: {} });

    await busJob(env, new Date(), new AbortController().signal);

    const snap = await getSnapshot(env, "bus", CONFIG_KEY);
    expect(snap?.state).toBe("ok");
    const status = snap?.data as { boards: Array<{ departures: unknown[] }> };
    expect(status.boards).toHaveLength(2);
    expect(status.boards.every((b) => b.departures.length === 0)).toBe(true);
  });

  it("换站后旧快照按新 configKey 读不到", async () => {
    await setDefaultWatchedLine();
    mockFetch(envelope([call({ aimed: new Date().toISOString() })], []));
    await busJob(env, new Date(), new AbortController().signal);
    expect((await getSnapshot(env, "bus", CONFIG_KEY))?.state).toBe("ok");

    await setWatchedLine({ watchedStopAId: "NSR:StopPlace:90004" });
    const newKey = `${LINE_ID}|NSR:StopPlace:90004|${STOP_B_ID}`;
    expect(await getSnapshot(env, "bus", CONFIG_KEY)).not.toBeNull(); // 旧行还在，只是 configKey 不同
    expect(await getSnapshot(env, "bus", newKey)).toBeNull();
  });
});

// ---- 错误路径 ----

describe("busJob：错误路径", () => {
  it("graphql errors 时 putFailure(upstream_4xx)，保留旧快照", async () => {
    await setDefaultWatchedLine();
    mockFetch({ data: null, errors: [{ message: "unknown stop" }] });

    await busJob(env, new Date(), new AbortController().signal);

    const row = await rawBusRow();
    expect(row?.state).toBe("stale");
    expect(row?.errorCode).toBe("upstream_4xx");
  });

  it("http 5xx 时 putFailure(upstream_5xx)", async () => {
    await setDefaultWatchedLine();
    mockFetch("server error", 500);

    await busJob(env, new Date(), new AbortController().signal);

    const row = await rawBusRow();
    expect(row?.state).toBe("stale");
    expect(row?.errorCode).toBe("upstream_5xx");
  });
});
