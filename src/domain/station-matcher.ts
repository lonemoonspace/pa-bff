// 从 app/.../data/train/StationMatcher.kt 移植。
//
// Entur 返回的站名带 "stasjon" 之类的展示后缀，这里只做展示层面的规整（大小写、
// 后缀、标点），刻意不做子串匹配——那会把方向不同的同名/相似站名误配上。

/** 折叠大小写、去掉 "stasjon" 后缀与标点差异后再比较，避免子串误配。 */
export function matches(actual: string | null | undefined, expected: string): boolean {
  return actual != null && normalize(actual) === normalize(expected);
}

/** 折叠大小写、去除 "stasjon"（全部出现）、把非字母数字规整为单个空格并去首尾空白。 */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("stasjon", "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
