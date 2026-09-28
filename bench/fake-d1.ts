// 基准脚本专用的 D1 替身：真实建表 + 真实 SQL（借助 Node 内置的 node:sqlite），只是把
// D1 的网络往返换成进程内 SQLite——按 P8 通用约定第 2 条与本卡「只替 I/O，不替计算」，
// 我们要测的是各任务处理器里 zod 解析 / 领域计算 / JSON 序列化的 CPU 开销，D1 本身的
// 查询延迟不是本卡关心的对象，但又不能干脆不跑这些 SQL（那样会跳过处理器里真实存在的
// 读写路径，例如 loadSettingsOrFallback / getSecretPlain / snapshot.putSuccess）。
//
// 覆盖面：与本卡目标任务（weather / traffic_outbound / football / bus / train）用到的
// D1 接口一致——env.DB.prepare().bind().run()/.all()/.first()，以及 drizzle-orm 的
// D1 driver 依赖的 client.prepare(sql).bind(...params).run()/.all()。不含 batch()
// 的完整语义（本卡目标任务都不需要它），仅给出可用的最小实现，避免类型报错。
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function migrationSql(): string {
  // 迁移目录下只有一个 0000_*.sql（P1 起未再新增迁移文件）；按文件名前缀取，不写死具体名字，
  // 迁移目录改名不会悄悄让基准脚本读到空文件而不报错。
  const files = readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf-8");
  const journal = JSON.parse(files) as { entries: { tag: string }[] };
  return journal.entries.map((e) => readFileSync(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), "utf-8")).join("\n");
}

class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sqlText: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sqlText, params);
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number }; results: unknown[] }> {
    const info = this.db.prepare(this.sqlText).run(...(this.params as never[]));
    return {
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
      results: [],
    };
  }

  async all<T = Record<string, unknown>>(): Promise<{ success: true; meta: Record<string, never>; results: T[] }> {
    const rows = this.db.prepare(this.sqlText).all(...(this.params as never[])) as T[];
    return { success: true, meta: {}, results: rows };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sqlText).get(...(this.params as never[])) as T | undefined;
    return row ?? null;
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const rows = this.db.prepare(this.sqlText).all(...(this.params as never[])) as Record<string, unknown>[];
    return rows.map((r) => Object.values(r)) as T[];
  }
}

/** 供 drizzle-orm 的 d1 driver 与各 store 模块直接调用的最小 D1Database 替身。 */
export class FakeD1Database {
  readonly raw: DatabaseSync;

  constructor() {
    this.raw = new DatabaseSync(":memory:");
    for (const stmt of migrationSql().split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) this.raw.exec(trimmed);
    }
  }

  prepare(sqlText: string): FakeStatement {
    return new FakeStatement(this.raw, sqlText);
  }

  /** 目标任务都不依赖 batch 的完整语义（认领/配对相关代码才用到），给一个够用的实现即可。 */
  async batch(stmts: FakeStatement[]): Promise<{ results: unknown[] }[]> {
    const out: { results: unknown[] }[] = [];
    for (const s of stmts) out.push(await s.all());
    return out;
  }

  /** 直接执行 SQL（基准脚本用来做迭代之间的数据播种，不计入被测函数的耗时）。 */
  exec(sqlText: string): void {
    this.raw.exec(sqlText);
  }
}
