// 从 app/.../domain/WeatherSymbols.kt 逐字移植：MET 天气符号代码 → 中文 + emoji 文案。
const MAP: Record<string, string> = {
  clearsky: "☀️ 晴",
  fair: "🌤 少云",
  partlycloudy: "⛅ 多云",
  cloudy: "☁️ 阴",
  lightrain: "🌦 小雨",
  rain: "🌧 雨",
  heavyrain: "🌧 大雨",
  lightrainshowers: "🌦 小阵雨",
  rainshowers: "🌦 阵雨",
  heavyrainshowers: "🌧 大阵雨",
  lightrainshowersandthunder: "⛈ 小阵雨雷暴",
  rainshowersandthunder: "⛈ 阵雨雷暴",
  heavyrainshowersandthunder: "⛈ 大阵雨雷暴",
  lightsleetshowers: "🌨 小冰雨阵雨",
  sleetshowers: "🌨 冰雨阵雨",
  heavysleetshowers: "🌨 大冰雨阵雨",
  // MET 官方历史符号名保留了 light 后多出的 s。
  lightssleetshowersandthunder: "⛈ 小冰雨阵雨雷暴",
  sleetshowersandthunder: "⛈ 冰雨阵雨雷暴",
  heavysleetshowersandthunder: "⛈ 大冰雨阵雨雷暴",
  lightsleet: "🌨 小冰雨",
  sleet: "🌨 雨夹雪",
  heavysleet: "🌨 大冰雨",
  lightrainandthunder: "⛈ 小雨雷暴",
  rainandthunder: "⛈ 雷阵雨",
  heavyrainandthunder: "⛈ 大雨雷暴",
  lightsleetandthunder: "⛈ 小冰雨雷暴",
  sleetandthunder: "⛈ 冰雨雷暴",
  heavysleetandthunder: "⛈ 大冰雨雷暴",
  lightsnowshowers: "❄️ 小雪阵雨",
  snowshowers: "❄️ 阵雪",
  heavysnowshowers: "❄️ 大雪阵雨",
  // MET 官方历史符号名保留了 light 后多出的 s。
  lightssnowshowersandthunder: "⛈ 小雪阵雨雷暴",
  snowshowersandthunder: "⛈ 雪阵雨雷暴",
  heavysnowshowersandthunder: "⛈ 大雪阵雨雷暴",
  lightsnow: "❄️ 小雪",
  snow: "❄️ 雪",
  heavysnow: "❄️ 大雪",
  lightsnowandthunder: "⛈ 小雪雷暴",
  snowandthunder: "⛈ 雪雷暴",
  heavysnowandthunder: "⛈ 大雪雷暴",
  fog: "🌫 雾",
  wind: "💨 大风",
};

/** Kotlin `code.substringBefore("_")`：无 "_" 时返回整串。 */
export function toZh(code: string): string {
  const idx = code.indexOf("_");
  const key = idx === -1 ? code : code.slice(0, idx);
  // Kotlin 的 Map.get 只看「有没有这个键」，不会被 constructor/toString/hasOwnProperty/
  // valueOf 这些 Object.prototype 继承来的属性名撞上；用 Object.hasOwn 精确判断自有键，
  // 而不是 `MAP[key]`（那样会取到原型链上的函数，而不是 undefined）。
  return Object.hasOwn(MAP, key) ? MAP[key]! : `🌡 ${key}`;
}
