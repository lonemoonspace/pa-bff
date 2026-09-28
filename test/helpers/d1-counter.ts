// 测试专用：包一层 env.DB，统计 prepare() 调用次数（batch 里的每条语句也在各自
// prepare() 时就被记过一次，不需要在 batch() 里重复计数），并提供 onPrepare 钩子——
// 在某条语句真正执行前（run/all/first/raw，或它被塞进 batch() 调用时）触发，用来
// 模拟「另一个执行抢先写库」。
//
// 用 Proxy 包住真实的 D1PreparedStatement / D1Database，只拦截我们关心的几个方法，
// 其余属性/方法原样转发给真实对象——这样包装后的对象仍然是货真价实的 D1 对象，可以
// 放心传给 drizzle 或直接塞进 env.DB.batch()。

export interface D1CounterOptions {
  /** 在某条语句执行前触发（可以是异步的，例如插入一次并发写入）。 */
  onPrepare?: (sql: string) => Promise<void> | void;
}

export interface InstrumentedD1 {
  /** 替换 env.DB 用的包装实例。 */
  db: D1Database;
  /** 迄今为止 prepare() 被调用的次数。 */
  count(): number;
  /** 迄今为止每次 prepare() 传入的 SQL，顺序与调用顺序一致。 */
  sqls(): string[];
}

const EXEC_METHODS = ["run", "all", "first", "raw"] as const;

function wrapStatement(
  target: D1PreparedStatement,
  sql: string,
  onPrepare: ((sql: string) => Promise<void> | void) | undefined,
): D1PreparedStatement {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === "bind") {
        const bind = Reflect.get(obj, prop, obj) as (...values: unknown[]) => D1PreparedStatement;
        return (...values: unknown[]) => wrapStatement(bind.apply(obj, values), sql, onPrepare);
      }
      if ((EXEC_METHODS as readonly string[]).includes(prop as string)) {
        const fn = Reflect.get(obj, prop, obj) as (...args: unknown[]) => unknown;
        return async (...args: unknown[]) => {
          if (onPrepare) await onPrepare(sql);
          return fn.apply(obj, args);
        };
      }
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
    },
  });
}

/** 供 wrapStatement 之外（例如 batch()）反查某个已包装语句对应的原始 SQL。 */
const sqlOfStatement = new WeakMap<object, string>();

function wrapAndRemember(
  target: D1PreparedStatement,
  sql: string,
  onPrepare: ((sql: string) => Promise<void> | void) | undefined,
): D1PreparedStatement {
  const wrapped = wrapStatement(target, sql, onPrepare);
  sqlOfStatement.set(wrapped, sql);
  return wrapped;
}

export function instrumentD1(database: D1Database, options: D1CounterOptions = {}): InstrumentedD1 {
  const sqlLog: string[] = [];
  const { onPrepare } = options;

  const wrapped: D1Database = new Proxy(database, {
    get(obj, prop, receiver) {
      if (prop === "prepare") {
        return (query: string) => {
          sqlLog.push(query);
          const stmt = obj.prepare(query);
          return wrapAndRemember(stmt, query, onPrepare);
        };
      }
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (onPrepare) {
            for (const s of statements) {
              const sql = sqlOfStatement.get(s) ?? "";
              await onPrepare(sql);
            }
          }
          return obj.batch(statements);
        };
      }
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
    },
  }) as D1Database;

  return {
    db: wrapped,
    count: () => sqlLog.length,
    sqls: () => [...sqlLog],
  };
}
