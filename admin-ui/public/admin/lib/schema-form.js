// @ts-check
// 纯函数：把 JSON Schema（GET /admin/api/settings/schema，z.toJSONSchema(SettingsSchema)）
// 与一份中文标签表拼成表单字段描述，以及表单值与设置对象之间的双向转换。不碰 DOM，
// 供 pages/settings.js 与 test/admin-ui/schema-form.test.ts 共用。

/**
 * @typedef {{ key: string, kind: "string" | "boolean", maxLength: number | null, defaultValue: unknown, label: string, group: string }} Field
 */

/**
 * @typedef {{ key: string, label: string, group: string }} LabelEntry
 */

/**
 * @typedef {{ properties?: Record<string, { type?: string, maxLength?: number, default?: unknown }> }} JsonSchema
 */

/**
 * 按 labels 的顺序排列；schema 里有而 labels 里没有的字段排在最后、用 key 当标签
 * （将来加字段不用改前端）。labels 里有而 schema 里没有的字段忽略。
 * @param {JsonSchema} jsonSchema
 * @param {LabelEntry[]} labels
 * @returns {Field[]}
 */
export function buildFields(jsonSchema, labels) {
  const properties = jsonSchema.properties ?? {};
  const labelByKey = new Map(labels.map((entry) => [entry.key, entry]));

  const labeledKeys = labels
    .map((entry) => entry.key)
    .filter((key) => Object.prototype.hasOwnProperty.call(properties, key));
  const unlabeledKeys = Object.keys(properties).filter((key) => !labelByKey.has(key));
  const orderedKeys = [...labeledKeys, ...unlabeledKeys];

  return orderedKeys.map((key) => {
    const prop = properties[key] ?? {};
    const entry = labelByKey.get(key);
    /** @type {"string" | "boolean"} */
    const kind = prop.type === "boolean" ? "boolean" : "string";
    return {
      key,
      kind,
      maxLength: typeof prop.maxLength === "number" ? prop.maxLength : null,
      defaultValue: prop.default,
      label: entry ? entry.label : key,
      group: entry ? entry.group : "其他",
    };
  });
}

/**
 * 把表单原始值转换回设置对象：布尔字段转 Boolean，字符串字段去首尾空白、缺失当空串。
 * @param {Field[]} fields
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
export function collectValues(fields, raw) {
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const field of fields) {
    const value = raw[field.key];
    if (field.kind === "boolean") {
      result[field.key] = Boolean(value);
    } else {
      result[field.key] = typeof value === "string" ? value.trim() : "";
    }
  }
  return result;
}

/**
 * 两个设置对象之间取值不同的字段名列表（按 a 里出现的顺序，再补上只在 b 里出现的字段）。
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 * @returns {string[]}
 */
export function diffSettings(a, b) {
  /** @type {string[]} */
  const keys = [];
  for (const key of Object.keys(a)) keys.push(key);
  for (const key of Object.keys(b)) if (!keys.includes(key)) keys.push(key);
  return keys.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}
