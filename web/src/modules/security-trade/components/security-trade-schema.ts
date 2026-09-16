/**
 * modules/security-trade/components/security-trade-schema.ts — 证券买卖表单 schema（纯位置拆出）
 *
 * 自 SecurityTradeForm.vue 原样平移：资产类型选项、费用/公共字段、单一 tradeSchema
 * （录入 / 编辑共用）以及编辑态成交额回填与成功后重置的纯函数工具。
 * 校验规则与错误提示文案逐字不变；本模块不含任何数据 hook。
 */

import { z } from 'zod';
import { toIsoDate } from '@/lib/constants';
import { SecuritySide, SecurityType, sumMoney } from '@/lib/types';

/** 资产类型选项(供手动修改使用),与 React 版逐字一致 */
export const SECURITY_TYPE_OPTIONS: ReadonlyArray<{ value: SecurityType; label: string }> = [
  { value: SecurityType.STOCK, label: '股票' },
  { value: SecurityType.ON_EXCHANGE_FUND, label: '场内基金' },
  { value: SecurityType.OFF_EXCHANGE_FUND, label: '场外基金' },
  { value: SecurityType.BOND, label: '债券' },
  { value: SecurityType.CONVERTIBLE_BOND, label: '可转债' },
  { value: SecurityType.INDEX, label: '指数' },
  { value: SecurityType.HK_STOCK, label: '港股' },
  { value: SecurityType.OTHER, label: '其他' },
  // 后端可合法下发 UNCATEGORIZED（代码无法可靠归类时的兜底类型）。必须纳入下拉项，
  // 否则该标的值命中时 reka-ui Select 无匹配项、回退显示「无法推断类型」占位符（见 BugFix）。
  { value: SecurityType.UNCATEGORIZED, label: '未分类' },
];

/** 费用字段:可选、非负、最多 2 位小数 */
const feeFieldSchema = z
  .string()
  .optional()
  .refine((v) => !v || /^\d+(\.\d{1,2})?$/.test(v), '费用最多 2 位小数')
  .refine((v) => !v || Number(v) >= 0, '费用不能为负');

/** 公共字段:方向 / 日期 / 标的 / 数量 / 备注 */
const baseFields = {
  date: z
    .string()
    .min(1, '请选择日期')
    .refine((v) => v <= toIsoDate(new Date()), '日期不能为未来'),
  side: z.nativeEnum(SecuritySide),
  securityId: z.string().min(1, '请选择标的'),
  // Vue 对 type=number 输入的 v-model 会自动把值转为数字,
  // 此处先归一为字符串,保持与 React 版 z.string() 同口径(错误消息不变)
  quantity: z.preprocess(
    (v) => (typeof v === 'number' ? String(v) : v),
    z
      .string()
      .min(1, '请输入数量')
      .refine((v) => Number(v) > 0, '数量必须大于 0'),
  ),
  note: z.string().max(200, '备注最多 200 字').optional(),
};

/**
 * 单一 schema(录入 / 编辑共用)。
 *
 * 成交额允许最多 6 位小数:录入态用户通常输入 2 位金额;编辑态回填 q × costPrice −/+ feeTotal
 * 可能产生 3~6 位小数(costPrice 为 6 位小数),若截断到 2 位会破坏「不改动即成本守恒」。
 */
export const tradeSchema = z
  .object({
    ...baseFields,
    tradeAmount: z
      .string()
      .min(1, '请输入成交额')
      .refine((v) => /^\d+(\.\d{1,6})?$/.test(v), '成交额最多 6 位小数')
      .refine((v) => Number(v) > 0, '成交额必须大于 0'),
    commission: feeFieldSchema,
    stampTax: feeFieldSchema,
    other: feeFieldSchema,
  })
  // 卖出费用合计 > 成交额 → 阻止(C-7 前端闸 + 后端 costPrice>0 DTO 兜底)
  .superRefine((data, ctx) => {
    if (data.side !== SecuritySide.SELL_SEC) return;
    const feeTotal = sumMoney([
      data.commission || '0',
      data.stampTax || '0',
      data.other || '0',
    ]);
    if (Number(feeTotal) > Number(data.tradeAmount || '0')) {
      ctx.addIssue({
        code: 'custom',
        path: ['tradeAmount'],
        message: '费用合计不能超过成交额',
      });
    }
  });

export type TradeFormValues = z.infer<typeof tradeSchema>;

/** 6 位小数字符串(编辑态成交额回填用;去除尾随零避免输入框显示 123.450000) */
export function toPrecision6(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round(n * 1e6) / 1e6);
}

/** 新建成功后的表单重置值(录入 / 编辑共用);today 由门面同帧传入,保持原行为 */
export function createResetDefaults(today: string): TradeFormValues {
  return {
    date: today,
    side: SecuritySide.BUY_SEC,
    securityId: '',
    quantity: '',
    tradeAmount: '',
    commission: '',
    stampTax: '',
    other: '',
    note: '',
  };
}
