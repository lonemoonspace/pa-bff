// D1 + Drizzle 客户端封装，统一从这里拿 db 实例。
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env";
import * as schema from "./schema";

export type Db = ReturnType<typeof db>;

/** 返回绑定了当前 Worker Env.DB 的 drizzle 实例。 */
export function db(env: Env) {
  return drizzle(env.DB, { schema });
}
