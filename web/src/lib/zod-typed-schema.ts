/**
 * lib/zod-typed-schema — zod schema 到 vee-validate TypedSchema 的适配（全站共享）
 *
 * 项目未引入 @vee-validate/zod，这里按 vee-validate 的 TypedSchema 协议
 * （__type: 'VVTypedSchema' + parse）包装 zod schema：safeParseAsync 后把
 * issues 按 path 归组为 TypedSchemaError，校验消息逐字透传（与 React 版
 * zodResolver 的错误归位行为一致，跨字段 refine 的错误按 path 落到对应字段）。
 *
 * 注意：vee-validate 的 useForm 仅识别 TypedSchema 或按字段组织的对象 schema，
 * 直接传顶层函数会被静默忽略（不执行校验）。
 *
 * 与 modules/auth/composables/zod-validation.ts 实现同源；auth 模块已稳定，
 * 新模块（cashflow / cash-balance 等）统一引用本共享实现，避免跨业务模块依赖。
 */

import type { TypedSchema, TypedSchemaError } from 'vee-validate';
import type { z } from 'zod';

/**
 * 把 zod schema 转为 vee-validate 可用的 TypedSchema。
 *
 * 同一字段出现多条 issue 时按序全部收集（vee-validate 展示时取首条），
 * 与 zodResolver 每字段取首条错误的行为一致。
 */
export function zodToTypedSchema<TSchema extends z.ZodType>(
  schema: TSchema,
): TypedSchema<z.input<TSchema>, z.output<TSchema>> {
  return {
    __type: 'VVTypedSchema',
    async parse(values) {
      const result = await schema.safeParseAsync(values);
      if (result.success) {
        return { value: result.data, errors: [] };
      }
      // 同 path 的 issue 归组（path 多级时以 '.' 连接，本模块均为一级字段）
      const byPath = new Map<string, TypedSchemaError>();
      for (const issue of result.error.issues) {
        const path = issue.path.length ? issue.path.map(String).join('.') : undefined;
        const key = path ?? '';
        if (!byPath.has(key)) {
          byPath.set(key, { path, errors: [] });
        }
        byPath.get(key)!.errors.push(issue.message);
      }
      return { errors: [...byPath.values()] };
    },
  };
}
