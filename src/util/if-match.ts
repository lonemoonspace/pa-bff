// If-Match 头解析：/v1/settings 与 /admin/api/{settings,import} 共用同一套乐观锁语义
// （见 src/api/settings.ts、src/api/admin/settings.ts 的文件头注释），只在这里维护一份，
// 避免两处判断悄悄走样。
/**
 * 解析 If-Match 头里的 revision。接受带引号（"r5"）与不带引号（r5）两种写法，
 * 也接受弱校验前缀 W/。解析失败（格式不对）返回 null，调用方按“必然冲突”处理，
 * 不当作缺失头处理——因为头确实存在，只是内容不合法，语义上更接近“你给的版本对不上”。
 */
export function parseIfMatchRevision(headerValue: string): number | null {
  let v = headerValue.trim();
  if (v.startsWith("W/")) v = v.slice(2).trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
  const m = /^r(\d+)$/.exec(v);
  return m ? Number(m[1]) : null;
}
