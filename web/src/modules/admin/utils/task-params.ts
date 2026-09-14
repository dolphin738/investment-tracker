/**
 * modules/admin/utils/task-params.ts — 定时任务 JSON 对象参数（type=json 且含 map_of）的读写辅助。
 *
 * SchedulePage（parseParams 提交转换）与 TaskParamFields（字段级受控渲染）共用：
 * 表单内部以「JSON 字符串」承载，本模块负责「JSON 字符串 ↔ 各级别数字」互转。
 */

/** 把表单里存的 JSON 字符串解析成对象；非法时回退空对象 */
export function jsonObjectOf(raw: unknown): Record<string, number> {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        return o as Record<string, number>;
      }
    } catch {
      /* 忽略非法 JSON，回退空对象 */
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, number>;
  }
  return {};
}

/** 取某级别当前值（数字转字符串，供 input 显示） */
export function jsonFieldValue(raw: unknown, sub: string): string {
  const o = jsonObjectOf(raw);
  const v = o[sub];
  return v == null ? '' : String(v);
}

/** 更新某级别的值，返回写回表单的新 JSON 字符串（空值 = 删除该级别键） */
export function setJsonKey(raw: unknown, sub: string, val: string): string {
  const o = jsonObjectOf(raw);
  if (val.trim() === '') delete o[sub];
  else o[sub] = Number(val);
  return JSON.stringify(o);
}
