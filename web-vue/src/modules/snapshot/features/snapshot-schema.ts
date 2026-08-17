/**
 * modules/snapshot/features/snapshot-schema.ts — 资产快照表单校验 schema（PRD §7.3）
 *
 * 平移自 React 版 web/src/features/snapshot/snapshot-form.tsx 内的 snapshotSchema
 * （抽为独立文件，供表单与单测复用），规则逐字一致：
 * - 日期 .min(1) + refine(不能为未来)
 * - 当日总资产 totalAsset .min(1) + refine(> 0)
 * - 持仓市值 marketValue 可选 + refine(>= 0)
 * - 现金余额 cashBalance 可选 + refine(>= 0)
 * - 备注 .max(200)
 */

import { z } from 'zod';
import { toIsoDate } from '@/lib/constants';

/**
 * Vue 对 type=number 输入的 v-model 会自动把值转为数字（与 React 的 string 承载
 * 不同），此处先用 preprocess 把数字归一为字符串，保持与 React 版 z.string() 同口径，
 * 校验消息逐字一致（Decimal 以 string 传输铁律不变）。
 */
const toNullableString = (v: unknown): unknown =>
  typeof v === 'number' ? String(v) : v;

/** 快照表单 schema（全部字段以 string 承载，金额遵守「Decimal 以 string 传输」铁律） */
export const snapshotSchema = z.object({
  date: z
    .string()
    .min(1, '请选择日期')
    .refine((v) => v <= toIsoDate(new Date()), '日期不能为未来'),
  totalAsset: z.preprocess(
    toNullableString,
    z
      .string()
      .min(1, '请输入资产总额')
      .refine((v) => Number(v) > 0, '金额必须大于 0'),
  ),
  marketValue: z.preprocess(
    toNullableString,
    z
      .string()
      .optional()
      .refine((v) => !v || Number(v) >= 0, '持仓市值不能为负'),
  ),
  cashBalance: z.preprocess(
    toNullableString,
    z
      .string()
      .optional()
      .refine((v) => !v || Number(v) >= 0, '现金余额不能为负'),
  ),
  note: z.string().max(200, '备注最多 200 字').optional(),
});

/** 快照表单值类型 */
export type SnapshotFormValues = z.infer<typeof snapshotSchema>;
