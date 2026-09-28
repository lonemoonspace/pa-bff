// 对应 FootballRepositoryTest.kt 的可移植用例（近期赛程/赛果的挑选与排序、积分榜/射手榜
// TTL 复用、失败沿用旧榜单、令牌桶耗尽不发请求）。D1 是真的（vitest-pool-workers），
// football-data.org 走 vi.spyOn(globalThis, "fetch")，不访问真实网络。
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FootballStatus } from "../../src/contract/dashboard";
import { footballJob } from "../../src/jobs/football";
import { putSecret } from "../../src/secrets/store";
import { get as getSnapshot } from "../../src/snapshot/store";
import { BUCKET_CAPACITY } from "../../src/util/rate-bucket";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// isolatedStorage 是按测试文件隔离，不是按用例：令牌桶与 football 快照都是跨用例持久的
// D1 状态。多个用例复用同一批固定的 `now`，若不清空：(1) 令牌桶会被前一个用例耗尽；
// (2) football 快照带着的 league.updatedAt 会落在下一个用例的 30 分钟 TTL 窗口内，
// 让 refreshLeagueTables 误判「还在 TTL 内」而复用上一个用例写下的（往往是空的）榜单。
// 每个用例开始前把两者都清空，让每个用例都从「从未刷新过」的状态开始。
beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_buckets WHERE name = 'football_data'");
  await env.DB.exec("DELETE FROM snapshots WHERE source = 'football'");
});

const CONFIG_KEY = "86";

interface FdoMatchInput {
  id: number;
  utcDate: string;
  homeName?: string;
  awayName?: string;
  homeId?: number;
  homeScore?: number | null;
  awayScore?: number | null;
  status?: string;
}

function fdoMatch({
  id,
  utcDate,
  homeName = "Real Madrid",
  awayName = "Inter Milan",
  homeId = 86,
  homeScore = null,
  awayScore = null,
  status = "FINISHED",
}: FdoMatchInput): unknown {
  return {
    id,
    utcDate,
    competition: { name: "UEFA Champions League" },
    homeTeam: { id: homeId, name: homeName },
    awayTeam: { id: 200, name: awayName },
    score: { fullTime: { home: homeScore, away: awayScore } },
    status,
  };
}

const emptyStandings = { season: { currentMatchday: null }, standings: [] };
const emptyScorers = { season: { currentMatchday: null }, scorers: [] };

/** 按 url 分流：teams 的 matches 端点走 matches，standings/scorers 各自走对应数据；令牌桶请求不经过这里。 */
function mockFetch(opts: {
  matches?: unknown[];
  standings?: unknown;
  scorers?: unknown;
  matchesStatus?: number;
  leagueFails?: boolean;
}): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
    const u = String(url);
    if (u.includes("/matches")) {
      return Promise.resolve(
        new Response(JSON.stringify({ matches: opts.matches ?? [] }), { status: opts.matchesStatus ?? 200 }),
      );
    }
    if (u.includes("/standings")) {
      if (opts.leagueFails) return Promise.resolve(new Response("error", { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify(opts.standings ?? emptyStandings), { status: 200 }));
    }
    if (u.includes("/scorers")) {
      if (opts.leagueFails) return Promise.resolve(new Response("error", { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify(opts.scorers ?? emptyScorers), { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

async function setApiKey(key = "test-key-abc"): Promise<void> {
  const result = await putSecret(env, "football_data", key);
  if (!result.ok) throw new Error("putSecret 失败");
}

async function drainRateBucket(): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_buckets WHERE name = 'football_data'").run();
  await env.DB.prepare("INSERT INTO rate_buckets (name, tokens, updated_at) VALUES ('football_data', 0, ?)")
    .bind(new Date().toISOString())
    .run();
}

async function rawFootballRow(): Promise<{ state: string | null; errorCode: string | null } | null> {
  const row = await env.DB.prepare("SELECT state, error_json FROM snapshots WHERE source = 'football'").first<{
    state: string | null;
    error_json: string | null;
  }>();
  if (!row) return null;
  const error = row.error_json ? (JSON.parse(row.error_json) as { code: string }) : null;
  return { state: row.state, errorCode: error?.code ?? null };
}

describe("footballJob：设置/密钥缺失", () => {
  it("未配置 football_data 密钥 → not_configured，不发请求", async () => {
    await env.DB.exec("DELETE FROM secrets WHERE name = 'football_data'");
    const fetchSpy = mockFetch({});

    await footballJob(env, new Date("2026-09-07T12:00:00.000Z"), new AbortController().signal);

    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await rawFootballRow();
    expect(row?.state).toBe("not_configured");
  });
});

describe("footballJob：令牌桶", () => {
  it("令牌耗尽时不发请求，putFailure(rate_limited) 并让调度退避", async () => {
    await setApiKey();
    await drainRateBucket();
    const fetchSpy = mockFetch({ matches: [fdoMatch({ id: 1, utcDate: "2026-12-01T15:00:00Z", status: "SCHEDULED" })] });

    await expect(footballJob(env, new Date("2026-09-07T12:00:00.000Z"), new AbortController().signal)).rejects.toThrow();

    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await rawFootballRow();
    expect(row?.state).toBe("stale");
    expect(row?.errorCode).toBe("rate_limited");
  });
});

describe("footballJob：赛程挑选", () => {
  const now = new Date("2026-09-07T12:00:00.000Z");

  it("接下来三场按开球时间升序（对应「shows the next three upcoming matches」）", async () => {
    await setApiKey();
    mockFetch({
      matches: [
        fdoMatch({ id: 1, utcDate: "2026-09-07T15:00:00Z", awayName: "Far" }),
        fdoMatch({ id: 2, utcDate: "2026-09-07T12:20:00Z", awayName: "Close" }),
        fdoMatch({ id: 3, utcDate: "2026-09-07T13:00:00Z", awayName: "Mid" }),
        fdoMatch({ id: 4, utcDate: "2026-09-06T12:00:00Z", status: "FINISHED", homeScore: 1, awayScore: 0, awayName: "Old" }),
      ],
    });

    await footballJob(env, now, new AbortController().signal);

    const snap = await getSnapshot(env, "football", CONFIG_KEY);
    const status = snap?.data as FootballStatus;
    expect(status.nextMatches.map((m) => m.idEvent)).toEqual(["2", "3", "1"]);
  });

  it("最近三场赛果按开球时间降序，未来赛程被排除（对应「shows the latest three played results」）", async () => {
    await setApiKey();
    mockFetch({
      matches: [
        fdoMatch({ id: 30, utcDate: "2026-09-07T11:30:00Z", status: "FINISHED", homeScore: 1, awayScore: 0, awayName: "Newest" }),
        fdoMatch({ id: 1440, utcDate: "2026-09-06T12:00:00Z", status: "FINISHED", homeScore: 2, awayScore: 1, awayName: "Middle" }),
        fdoMatch({ id: 4320, utcDate: "2026-09-04T12:00:00Z", status: "FINISHED", homeScore: 1, awayScore: 0, awayName: "Oldest" }),
        fdoMatch({ id: 99, utcDate: "2026-09-08T12:00:00Z", status: "SCHEDULED" }),
      ],
    });

    await footballJob(env, now, new AbortController().signal);

    const snap = await getSnapshot(env, "football", CONFIG_KEY);
    const status = snap?.data as FootballStatus;
    expect(status.lastMatches.map((m) => m.idEvent)).toEqual(["30", "1440", "4320"]);
  });

  it("无日期的比赛被排除在结果之外（对应「excludes undated matches」）", async () => {
    await setApiKey();
    mockFetch({
      matches: [
        fdoMatch({ id: 1, utcDate: "2026-09-06T12:00:00Z", status: "FINISHED", homeScore: 1, awayScore: 0 }),
        fdoMatch({ id: 2, utcDate: "", status: "FINISHED", homeScore: 3, awayScore: 1 }),
      ],
    });

    await footballJob(env, now, new AbortController().signal);

    const snap = await getSnapshot(env, "football", CONFIG_KEY);
    const status = snap?.data as FootballStatus;
    expect(status.lastMatches.map((m) => m.idEvent)).toEqual(["1"]);
  });

  it("刚开球 3 分钟的比赛只出现在一个列表里（对应「appears in exactly one of the two lists」）", async () => {
    await setApiKey();
    mockFetch({ matches: [fdoMatch({ id: 1, utcDate: "2026-09-07T11:57:00Z", status: "IN_PLAY" })] });

    await footballJob(env, now, new AbortController().signal);

    const snap = await getSnapshot(env, "football", CONFIG_KEY);
    const status = snap?.data as FootballStatus;
    const inUpcoming = status.nextMatches.some((m) => m.idEvent === "1");
    const inRecent = status.lastMatches.some((m) => m.idEvent === "1");
    expect(inUpcoming || inRecent).toBe(true);
    expect(inUpcoming && inRecent).toBe(false);
  });

  it("无日期记录不该挤掉已排序的真实赛程（对应「undated matches do not crowd out real scheduled fixtures」）", async () => {
    await setApiKey();
    mockFetch({
      matches: [
        fdoMatch({ id: 1, utcDate: "2026-09-08T15:00:00Z", status: "SCHEDULED", awayName: "Real" }),
        fdoMatch({ id: 2, utcDate: "", status: "SCHEDULED", awayName: "Undated1" }),
        fdoMatch({ id: 3, utcDate: "", status: "SCHEDULED", awayName: "Undated2" }),
        fdoMatch({ id: 4, utcDate: "", status: "SCHEDULED", awayName: "Undated3" }),
        fdoMatch({ id: 5, utcDate: "", status: "SCHEDULED", awayName: "Undated4" }),
      ],
    });

    await footballJob(env, now, new AbortController().signal);

    const snap = await getSnapshot(env, "football", CONFIG_KEY);
    const status = snap?.data as FootballStatus;
    expect(status.nextMatches.some((m) => m.idEvent === "1")).toBe(true);
  });

  it("比分与主场标记正确映射（对应「maps scores and home flag into match ui」）", async () => {
    await setApiKey();
    mockFetch({
      matches: [
        fdoMatch({
          id: 2506193,
          utcDate: "2026-08-30T15:00:00Z",
          homeName: "Real Madrid",
          awayName: "Málaga",
          status: "FINISHED",
          homeScore: 4,
          awayScore: 0,
        }),
      ],
    });

    await footballJob(env, now, new AbortController().signal);

    const snap = await getSnapshot(env, "football", CONFIG_KEY);
    const status = snap?.data as FootballStatus;
    const match = status.lastMatches[0]!;
    expect(match.homeScore).toBe(4);
    expect(match.awayScore).toBe(0);
    expect(match.isHome).toBe(true);
    expect(match.status).toBe("FINISHED");
  });

  it("窗口内没有任何比赛 → putFailure(empty_window)，调度退避（对应「throws when football-data org returns an empty window」）", async () => {
    await setApiKey();
    mockFetch({ matches: [] });

    await expect(footballJob(env, now, new AbortController().signal)).rejects.toThrow(/未返回可用赛程/);

    const row = await rawFootballRow();
    expect(row?.state).toBe("stale");
    expect(row?.errorCode).toBe("empty_window");
  });
});

describe("footballJob：积分榜/射手榜", () => {
  const now = new Date("2026-09-07T12:00:00.000Z");
  const laLigaStandings = {
    season: { currentMatchday: 6 },
    standings: [
      { type: "HOME", table: [{ position: 1, team: { id: 1, name: "Wrong table" } }] },
      {
        type: "TOTAL",
        table: [
          { position: 2, team: { id: 86, name: "Real Madrid CF", shortName: "Real Madrid" }, points: 12 },
          { position: 1, team: { id: 81, name: "FC Barcelona", shortName: "Barça" }, points: 15 },
        ],
      },
    ],
  };
  const laLigaScorers = {
    scorers: [
      { player: { name: "A" }, team: { id: 87, name: "Rayo" }, goals: 6 },
      { player: { name: "B" }, team: { id: 86, name: "Real Madrid CF", shortName: "Real Madrid" }, goals: 5 },
      { player: { name: "C" }, team: { id: 81, name: "Barça" }, goals: 5 },
      { player: { name: "D" }, team: { id: 78, name: "Atleti" }, goals: 4 },
    ],
  };
  const oneMatch = [fdoMatch({ id: 1, utcDate: "2026-12-01T15:00:00Z", status: "SCHEDULED" })];

  it("只取 TOTAL 榜且同进球数并列同名次（对应「use the TOTAL standings and rank tied scorers equally」）", async () => {
    await setApiKey();
    mockFetch({ matches: oneMatch, standings: laLigaStandings, scorers: laLigaScorers });

    await footballJob(env, now, new AbortController().signal);

    const snap = await getSnapshot(env, "football", CONFIG_KEY);
    const league = (snap?.data as FootballStatus).league!;
    expect(league.standings.map((r) => r.teamName)).toEqual(["Barça", "Real Madrid"]);
    expect(league.standings.map((r) => r.isRealMadrid)).toEqual([false, true]);
    expect(league.currentMatchday).toBe(6);
    expect(league.scorers.map((s) => s.rank)).toEqual([1, 2, 2, 4]);
    expect(league.scorers[1]!.isRealMadrid).toBe(true);
  });

  it("TTL 内复用榜单，过期后重新请求（对应「reused within the TTL and refetched after it」）", async () => {
    await setApiKey();
    let leagueCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/matches")) {
        return Promise.resolve(new Response(JSON.stringify({ matches: oneMatch }), { status: 200 }));
      }
      leagueCalls += 1;
      if (u.includes("/standings")) return Promise.resolve(new Response(JSON.stringify(laLigaStandings), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(laLigaScorers), { status: 200 }));
    });

    await footballJob(env, now, new AbortController().signal);
    await footballJob(env, new Date(now.getTime() + 60 * 10 * 1000), new AbortController().signal);
    expect(leagueCalls).toBe(2); // 第二次仍在 TTL 内，不应再请求榜单

    await footballJob(env, new Date(now.getTime() + 60 * 31 * 1000), new AbortController().signal);
    expect(leagueCalls).toBe(4);
  });

  it("榜单请求失败沿用旧榜单，不影响赛程主流程（对应「keeps previous tables and does not fail the fixtures refresh」）", async () => {
    await setApiKey();
    mockFetch({ matches: oneMatch, standings: laLigaStandings, scorers: laLigaScorers });
    await footballJob(env, now, new AbortController().signal);

    const later = new Date(now.getTime() + 60 * 60 * 1000 * 2);
    // 令牌桶按 10/分钟补充，两小时后早已补满，可以正常再次扣减。
    mockFetch({ matches: oneMatch, leagueFails: true });
    await footballJob(env, later, new AbortController().signal);

    const snap = await getSnapshot(env, "football", CONFIG_KEY);
    const status = snap?.data as FootballStatus;
    expect(status.nextMatches.map((m) => m.idEvent)).toEqual(["1"]);
    expect(status.league!.standings).toHaveLength(2);
  });
});

describe("footballJob：CadenceCtx", () => {
  it("返回最近一场需要关注的比赛的开球/估算终场时刻", async () => {
    await setApiKey();
    const now = new Date("2026-09-07T12:00:00.000Z");
    const kickoff = "2026-09-07T13:00:00Z";
    mockFetch({ matches: [fdoMatch({ id: 1, utcDate: kickoff, status: "SCHEDULED" })] });

    const ctx = await footballJob(env, now, new AbortController().signal);

    expect(ctx?.football?.kickoffAt.getTime()).toBe(new Date(kickoff).getTime());
    expect(ctx?.football?.endAt.getTime()).toBeGreaterThan(new Date(kickoff).getTime());
  });

  it("没有任何可解析日期的比赛时 CadenceCtx.football 为 null（赛程本身仍算刷新成功）", async () => {
    await setApiKey();
    const now = new Date("2026-09-07T12:00:00.000Z");
    mockFetch({ matches: [fdoMatch({ id: 1, utcDate: "", status: "SCHEDULED" })] });

    const ctx = await footballJob(env, now, new AbortController().signal);

    expect(ctx?.football ?? null).toBeNull();
  });
});

describe("footballJob：令牌桶保护免费额度", () => {
  // F9：修复前，refreshLeagueTables 里的 standings/scorers 请求不额外扣令牌（只有
  // footballJob 开头扣了 1 个），一次刷新实际发 3 个真实请求却只算 1 个令牌，10 次
  // 调用就可能悄悄打出 20+ 个真实请求，远超 football-data.org 免费计划 10 次/分钟的
  // 限额。修复后每个实际发出的请求各扣 1 个令牌（赛程 1 个 + 榜单最多 2 个）。
  it(`每个实际发出的请求各扣 1 个令牌（赛程 + 两张榜单最多 3 个），令牌耗尽时赛程本身也会失败（容量 ${BUCKET_CAPACITY}）`, async () => {
    await setApiKey();
    const now = new Date("2026-09-07T12:00:00.000Z");
    mockFetch({
      matches: [fdoMatch({ id: 1, utcDate: "2026-09-08T15:00:00Z", status: "SCHEDULED" })],
      standings: { season: { currentMatchday: 1 }, standings: [] },
      scorers: { scorers: [] },
    });

    // 第一次：赛程（1）+ 榜单首次刷新（2）= 3 个令牌，容量 10，剩 7。
    // 调用之间只推进毫秒级时间（而不是秒级），避免令牌桶按经过时间线性补充的规则
    // 在测试期间悄悄补出额外预算，掩盖「令牌耗尽」这件事本身。
    await footballJob(env, now, new AbortController().signal);
    expect((await rawFootballRow())?.state).toBe("ok");

    // 之后都在 30 分钟 TTL 内，榜单复用旧值，只需要赛程的 1 个令牌；正好把剩下的
    // 7 个预算用完。
    for (let i = 0; i < BUCKET_CAPACITY - 3; i++) {
      await footballJob(env, new Date(now.getTime() + i + 1), new AbortController().signal);
      expect((await rawFootballRow())?.state).toBe("ok");
    }

    // 令牌已耗尽：这次连赛程请求本身都拿不到令牌，应整体失败并让调度退避
    // （不是「悄悄多发几个不算钱的请求」）。
    await expect(
      footballJob(env, new Date(now.getTime() + BUCKET_CAPACITY - 2), new AbortController().signal),
    ).rejects.toThrow();
    const row = await rawFootballRow();
    expect(row?.state).toBe("stale");
    expect(row?.errorCode).toBe("rate_limited");
  });

  it("榜单令牌不足（TTL 已过期但只剩 1 个令牌）时跳过榜单刷新、沿用旧榜单，赛程仍正常更新", async () => {
    await setApiKey();
    const now = new Date("2026-09-07T12:00:00.000Z");
    const oldStandings = {
      season: { currentMatchday: 6 },
      standings: [{ type: "TOTAL", table: [{ position: 1, team: { id: 1, name: "Old A" }, points: 1 }, { position: 2, team: { id: 2, name: "Old B" }, points: 0 }] }],
    };
    mockFetch({ matches: [fdoMatch({ id: 1, utcDate: "2026-09-08T15:00:00Z", status: "SCHEDULED" })], standings: oldStandings, scorers: emptyScorers });
    await footballJob(env, now, new AbortController().signal);

    const later = new Date(now.getTime() + 60 * 60_000); // 超过 30 分钟 TTL，理应刷新榜单
    // 手动把令牌桶设到只剩 1 个：够赛程用（1 个），不够榜单两个请求。
    await env.DB.prepare("UPDATE rate_buckets SET tokens = 1, updated_at = ? WHERE name = 'football_data'")
      .bind(later.toISOString())
      .run();

    const newStandings = {
      season: { currentMatchday: 7 },
      standings: [{ type: "TOTAL", table: [{ position: 1, team: { id: 3, name: "New C" }, points: 9 }] }],
    };
    mockFetch({ matches: [fdoMatch({ id: 2, utcDate: "2026-09-09T15:00:00Z", status: "SCHEDULED" })], standings: newStandings, scorers: emptyScorers });

    await footballJob(env, later, new AbortController().signal);

    const snap = await getSnapshot(env, "football", CONFIG_KEY);
    const status = snap?.data as FootballStatus;
    // 赛程正常更新（用到了新数据）。
    expect(status.nextMatches.map((m) => m.idEvent)).toContain("2");
    // 榜单没被刷新：沿用的还是旧榜单（team "Old A"/"Old B"），不是新数据。
    expect(status.league!.standings.map((r) => r.teamName)).toEqual(["Old A", "Old B"]);
  });
});
