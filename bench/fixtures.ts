// 加载 test/fixtures 下的真实录制响应（P8 通用约定：基准要用真实响应做输入，不臆造)。
// 用 fs 读取 + JSON.parse，不用 import 断言——bench/ 没有纳入 tsconfig 的 include，
// 用最简单的方式读取即可，不必和 src/test 的模块解析方式保持一致。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadFixture<T = unknown>(relPath: string): T {
  const full = path.join(ROOT, "test", "fixtures", relPath);
  return JSON.parse(readFileSync(full, "utf-8")) as T;
}
