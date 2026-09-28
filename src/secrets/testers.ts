// 密钥测试函数注册表：各数据源卡在自己的模块里调用 registerTester() 注册真实测试逻辑
// （例如 T3.4 给 google_routes 注册一个最小的 computeRoutes 请求）。本卡（T3.0）只提供
// 注册机制本身，不认识任何具体数据源，所以未注册的名字统一给出「尚不支持测试」。
import type { Env } from "../env";
import type { SecretName } from "../contract/settings";

/** 测试结果：ok 表示密钥当前可用，message 给人看（中文），不得包含密钥内容。 */
export interface SecretTestResult {
  ok: boolean;
  message: string;
}

/** 密钥测试函数：拿到解密后的明文，发一个最小的真实请求验证可用性。 */
export type SecretTester = (env: Env, plaintext: string) => Promise<SecretTestResult>;

// 模块级单例：整个 isolate 生命周期内有效。各数据源卡的模块在被 import 时调用一次
// registerTester 完成注册；只要 jobs/index.ts 之类的入口把所有数据源模块 import 到，
// 注册就会在 Worker 启动时发生。
const testers = new Map<SecretName, SecretTester>();

/** 注册某个密钥名字对应的测试函数。重复注册会覆盖前一个（便于测试里替换成假实现）。 */
export function registerTester(name: SecretName, fn: SecretTester): void {
  testers.set(name, fn);
}

/**
 * 仅供测试使用：移除某个名字的 tester。各数据源模块在 Worker 入口被 import 时就会注册
 * 真实 tester（注册表是模块级单例），测试「未注册」分支时需要先把它移除。
 */
export function unregisterTesterForTest(name: SecretName): void {
  testers.delete(name);
}

/** 取出已注册的测试函数；未注册时返回 undefined。 */
export function getTester(name: SecretName): SecretTester | undefined {
  return testers.get(name);
}

/** 运行某个密钥的测试：未注册 tester 时给出统一的「尚不支持测试」，不抛异常。 */
export async function runTester(env: Env, name: SecretName, plaintext: string): Promise<SecretTestResult> {
  const tester = testers.get(name);
  if (!tester) {
    return { ok: false, message: "尚不支持测试" };
  }
  try {
    return await tester(env, plaintext);
  } catch (err) {
    // tester 内部未捕获的异常（网络错误等）不应该打断保存/测试接口本身。
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `测试失败：${message}` };
  }
}
