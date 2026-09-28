// football-data.org 客户端单测，对应 FootballDataOrgApiTest.kt 的每个用例。
// mock globalThis.fetch，不访问真实网络。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FDO_TEAM_ID,
  InvalidApiKeyError,
  fetchLaLigaScorers,
  fetchLaLigaStandings,
  fetchTeamMatches,
  verifyKey,
} from "../../src/sources/football";
import { SourceFailure } from "../../src/sources/http";
import matchesFixture from "../fixtures/football/matches.json";
import standingsFixture from "../fixtures/football/standings.json";
import scorersFixture from "../fixtures/football/scorers.json";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchTeamMatches", () => {
  it("请求 now 前后的日期窗口，而不是赛季开头（对应「requests a date window around now」）", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ matches: [] }), { status: 200 }));
    const now = new Date("2026-09-08T12:00:00Z");

    await fetchTeamMatches(86, "test-key", now);

    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error("expected fetch to be called");
    const [url, init] = call;
    expect(String(url)).toBe(
      "https://api.football-data.org/v4/teams/86/matches?dateFrom=2026-05-11&dateTo=2027-03-07&limit=100",
    );
    expect(new Headers((init as RequestInit).headers).get("X-Auth-Token")).toBe("test-key");
  });

  it("解析真实赛程响应形状（对应「parses real-world match envelope shape」）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(matchesFixture), { status: 200 }));

    const matches = await fetchTeamMatches(86, "test-key", new Date("2026-09-08T12:00:00Z"));

    expect(matches).toHaveLength(2);
    const upcoming = matches[0]!;
    expect(upcoming.id).toBe(4300001);
    expect(upcoming.competition?.name).toBe("Primera Division");
    expect(upcoming.utcDate).toBe("2026-09-08T19:00:00Z");
    expect(upcoming.status).toBe("SCHEDULED");
    expect(upcoming.homeTeam.id).toBe(86);
    expect(upcoming.awayTeam.name).toBe("Real Betis Balompié");
    expect(upcoming.homeTeam.crest).toBe("https://crests.football-data.org/86.png");
    const finished = matches[1]!;
    expect(finished.score?.fullTime?.home).toBe(4);
    expect(finished.score?.fullTime?.away).toBe(0);
  });

  it("HTTP 错误时抛 SourceFailure（对应「throws on http error」）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("denied", { status: 403 }));

    await expect(fetchTeamMatches(86, "test-key", new Date())).rejects.toMatchObject({
      code: "upstream_4xx",
    });
    await expect(fetchTeamMatches(86, "test-key", new Date())).rejects.toThrow(/403/);
  });

  it("空白 key 抛出指向设置页的错误（对应「rejects blank api key with settings hint」）", async () => {
    await expect(fetchTeamMatches(86, "  ", new Date())).rejects.toThrow(InvalidApiKeyError);
    await expect(fetchTeamMatches(86, "  ", new Date())).rejects.toThrow(/设置 → 皇马/);
  });
});

describe("verifyKey", () => {
  it("200 视为成功，403 给出明确提示（对应「verifyKey succeeds on 200 and explains 403」）", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const ok = await verifyKey("good-key");
    expect(ok.ok).toBe(true);
    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error("expected fetch to be called");
    const [url, init] = call;
    expect(String(url)).toBe(`https://api.football-data.org/v4/teams/${FDO_TEAM_ID}`);
    expect(new Headers((init as RequestInit).headers).get("X-Auth-Token")).toBe("good-key");

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("denied", { status: 403 }));
    const denied = await verifyKey("bad-key");
    expect(denied.ok).toBe(false);
    expect(denied.message).toMatch(/403/);
    expect(denied.message).toMatch(/Key/);
  });
});

describe("联赛榜单", () => {
  it("解析积分榜与射手榜响应", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("standings")) return Promise.resolve(new Response(JSON.stringify(standingsFixture), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(scorersFixture), { status: 200 }));
    });

    const standings = await fetchLaLigaStandings("test-key");
    const scorers = await fetchLaLigaScorers("test-key");

    expect(standings.season?.currentMatchday).toBe(6);
    expect(standings.standings.map((g) => g.type)).toEqual(["HOME", "TOTAL"]);
    expect(scorers.scorers).toHaveLength(4);
  });

  it("响应形状不对时归为 parse_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ standings: "not-an-array" }), { status: 200 }));

    await expect(fetchLaLigaStandings("test-key")).rejects.toBeInstanceOf(SourceFailure);
    await expect(fetchLaLigaStandings("test-key")).rejects.toMatchObject({ code: "parse_error" });
  });
});
