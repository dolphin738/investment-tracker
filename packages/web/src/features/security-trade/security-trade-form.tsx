/**
 * features/security-trade/security-trade-form.tsx — 证券买卖录入/编辑弹窗（I-01 编辑界面统一）
 *
 * 🆕 I-01（增量 PRD）：录入 / 编辑共用**同一 schema + 同一布局**，仅初始值与提交目标不同。
 * - 统一字段与顺序：方向 → 日期 → 标的 → 数量 → 成交额 → 费用三框（佣金/印花税/其他）
 *   → 含费单价（只读预览）→ 备注
 * - 统一公式（K-3，买入/卖出同式）：
 *   - 买入：price = (成交额 + 费用合计) / 数量
 *   - 卖出：price = (成交额 − 费用合计) / 数量；费用合计 > 成交额 → 阻止（C-7 前端闸）
 * - 编辑态回填（I-01 验收 3/4）：费用三框按 `transactionId = trade.id` 的 FeeRecord 按类型拆分回显；
 *   成交额按口径回填（新口径 `q×price −/+ feeTotal`；旧口径 `q×price`）
 * - 编辑保存重建 FeeRecord（裁决 Q-2）：DELETE 该 transactionId 关联的全部费用 → 对 amount>0
 *   的类型逐个 POST /fees（transactionId = trade.id，scenario = side 映射）—— 与录入态对称
 * - 旧口径提示：编辑态若 `trade.fee ≠ 0` 且无关联 FeeRecord → amber 提示「旧口径费用将并入含费单价」
 *
 * ⓘ 组合内部买卖，不计入出入金现金流。
 */

import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Info, Loader2, Plus } from 'lucide-react';
import { sumMoney } from '@investment-tracker/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreateSecurityTrade, useUpdateSecurityTrade } from '@/hooks/use-security-trades';
import { useSecurities, useCreateSecurity } from '@/hooks/use-securities';
import { useFees } from '@/hooks/use-fees';
import { createFee as createFeeApi, deleteFee as deleteFeeApi } from '@/api/fee.api';
import { toast } from 'sonner';
import { toIsoDate } from '@/lib/constants';
// SecurityType 与 SecuritySide 同源：唯一定义在 shared，前后端共用（Q-3）
import { SecuritySide, SecurityType } from '@investment-tracker/shared';
import { formatCurrency } from '@/lib/utils';
import { FeeType, FeeScenario } from '@/api/types';
import type { FeeRecord, SecurityTradeResponse } from '@/api/types';

/** 费用字段：可选、非负、最多 2 位小数 */
const feeFieldSchema = z
  .string()
  .optional()
  .refine((v) => !v || /^\d+(\.\d{1,2})?$/.test(v), '费用最多 2 位小数')
  .refine((v) => !v || Number(v) >= 0, '费用不能为负');

/** 公共字段：方向 / 日期 / 标的 / 数量 / 备注 */
const baseFields = {
  date: z
    .string()
    .min(1, '请选择日期')
    .refine((v) => v <= toIsoDate(new Date()), '日期不能为未来'),
  side: z.nativeEnum(SecuritySide),
  securityId: z.string().min(1, '请选择标的'),
  quantity: z
    .string()
    .min(1, '请输入数量')
    .refine((v) => Number(v) > 0, '数量必须大于 0'),
  note: z.string().max(200, '备注最多 200 字').optional(),
};

/**
 * 单一 schema（I-01：录入 / 编辑共用）。
 *
 * 成交额允许最多 6 位小数：录入态用户通常输入 2 位金额；编辑态回填 `q×price −/+ feeTotal`
 * 可能产生 3~6 位小数（price 为 6 位小数），若截断到 2 位会破坏「不改动即成本守恒」。
 */
const tradeSchema = z
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
  // 卖出费用合计 > 成交额 → 阻止（C-7 前端闸 + 后端 price>0 DTO 兜底）
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

type TradeFormValues = z.infer<typeof tradeSchema>;

export interface SecurityTradeFormProps {
  portfolioId: string;
  /** 传入则编辑，否则新建 */
  trade?: SecurityTradeResponse | null;
  /** 提交成功后回调（关闭弹窗） */
  onSuccess?: () => void;
  className?: string;
}

/** 标的类型中文映射 */
const SECURITY_TYPE_LABEL: Record<string, string> = {
  STOCK: '股票',
  FUND: '基金',
  BOND: '债券',
  CASH: '现金',
  OTHER: '其他',
};

/** side → FeeScenario（I-01/I-03：联动创建费用时场景自动取该笔流水方向） */
function scenarioOfSide(side: SecuritySide): FeeScenario {
  return side === SecuritySide.BUY_SEC ? FeeScenario.BUY : FeeScenario.SELL;
}

/** 6 位小数字符串（编辑态成交额回填用；去除尾随零避免输入框显示 123.450000） */
function toPrecision6(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round(n * 1e6) / 1e6);
}

export function SecurityTradeForm({
  portfolioId,
  trade,
  onSuccess,
  className,
}: SecurityTradeFormProps): JSX.Element {
  const isEdit = Boolean(trade);
  const createMutation = useCreateSecurityTrade();
  const updateMutation = useUpdateSecurityTrade();
  const createSecurityMutation = useCreateSecurity(portfolioId);
  const { data: securities = [], isLoading: secLoading } = useSecurities(portfolioId);
  const queryClient = useQueryClient();
  const today = toIsoDate(new Date());
  const [submitting, setSubmitting] = useState(false);
  // 新建标的折叠表单状态
  const [showNewSecurity, setShowNewSecurity] = useState(false);
  // 显式标注 type 为 SecurityType（shared 的 as const 联合类型）
  const [newSecurity, setNewSecurity] = useState<{
    code: string;
    name: string;
    type: SecurityType;
  }>({
    code: '',
    name: '',
    type: SecurityType.STOCK,
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<TradeFormValues>({
    resolver: zodResolver(tradeSchema),
    defaultValues: {
      date: today,
      side: SecuritySide.BUY_SEC,
      securityId: '',
      quantity: '',
      tradeAmount: '',
      commission: '',
      stampTax: '',
      other: '',
      note: '',
    },
  });

  /** 明细行费用（未 grouped 时 useFees 返回 FeeRecord[]；类型守卫剔除聚合行）。
   *  🔴 依赖用 feeData.data（undefined 稳定）而非 feeList 默认值，避免每次渲染
   *  新建空数组 → effect 依赖不稳 → reset 无限循环。 */
  const feeData = useFees(portfolioId);
  const feeRows = useMemo(
    () =>
      ((feeData.data ?? []) as Array<FeeRecord | { transactionId?: unknown }>).filter(
        (f): f is FeeRecord => typeof (f as FeeRecord).transactionId === 'string',
      ),
    [feeData.data],
  );

  /**
   * 编辑态回填（I-01 验收 3/4）：
   * - 费用三框按 transactionId = trade.id 的 FeeRecord 按类型拆分回显；未关联则空
   * - 成交额：新口径（fee=0 且有关联费用）`q×price −/+ feeTotal`；旧口径（fee≠0 且无关联）`q×price`
   * - 旧口径费用三框「其他」回填 trade.fee（佣金/印花税空），保存时自动并入含费单价（成本守恒）
   */
  useEffect(() => {
    if (trade) {
      const linkedFees = feeRows.filter((f) => f.transactionId === trade.id);
      const legacy = Number(trade.fee) !== 0 && linkedFees.length === 0;
      const feeByType = new Map(linkedFees.map((f) => [f.type, f.amount]));
      const feeTotal = Number(
        sumMoney([
          feeByType.get(FeeType.COMMISSION) || '0',
          feeByType.get(FeeType.STAMP_TAX) || '0',
          feeByType.get(FeeType.OTHER) || '0',
        ]),
      );
      const baseAmount = Number(trade.quantity) * Number(trade.price);
      const tradeAmount = legacy
        ? baseAmount
        : trade.side === SecuritySide.BUY_SEC
          ? baseAmount - feeTotal
          : baseAmount + feeTotal;
      reset({
        date: trade.date,
        side: trade.side as (typeof SecuritySide)[keyof typeof SecuritySide],
        securityId: trade.securityId,
        quantity: trade.quantity,
        tradeAmount: toPrecision6(tradeAmount),
        commission: feeByType.get(FeeType.COMMISSION) ?? '',
        stampTax: feeByType.get(FeeType.STAMP_TAX) ?? '',
        other: legacy ? trade.fee : (feeByType.get(FeeType.OTHER) ?? ''),
        note: trade.note ?? '',
      });
    } else {
      reset({
        date: today,
        side: SecuritySide.BUY_SEC,
        securityId: '',
        quantity: '',
        tradeAmount: '',
        commission: '',
        stampTax: '',
        other: '',
        note: '',
      });
    }
  }, [trade, feeRows, reset, today]);

  const sideValue = watch('side');
  const qtyValue = watch('quantity');
  const tradeAmountValue = watch('tradeAmount');
  const commissionValue = watch('commission');
  const stampTaxValue = watch('stampTax');
  const otherValue = watch('other');

  /** 费用合计（两态统一；输入未成型时 null） */
  const feeTotal = useMemo(() => {
    const inputs = [commissionValue, stampTaxValue, otherValue];
    if (inputs.some((v) => v && !/^\d+(\.\d{1,2})?$/.test(v))) return null;
    return sumMoney(inputs.map((v) => v || '0'));
  }, [commissionValue, stampTaxValue, otherValue]);

  /** 含费单价（只读实时预览，两态一致，K-3）：买入=(成交额+合计)/数量；卖出=(成交额−合计)/数量 */
  const derivedPrice = useMemo(() => {
    if (feeTotal === null) return null;
    const qty = Number(qtyValue);
    const amount = Number(tradeAmountValue);
    if (!qtyValue || !tradeAmountValue || Number.isNaN(qty) || Number.isNaN(amount)) {
      return null;
    }
    if (qty <= 0 || amount <= 0) return null;
    const raw =
      (sideValue === SecuritySide.BUY_SEC
        ? amount + Number(feeTotal)
        : amount - Number(feeTotal)) / qty;
    if (raw <= 0) return null;
    // K-3/U-3：单价收敛到 6 位小数后按现有 number 契约提交
    return Number(raw.toFixed(6));
  }, [feeTotal, qtyValue, tradeAmountValue, sideValue]);

  /** 旧口径提示（trade.fee ≠ 0 且无关联 FeeRecord） */
  const isLegacy = useMemo(() => {
    if (!trade) return false;
    const linked = feeRows.filter((f) => f.transactionId === trade.id);
    return Number(trade.fee) !== 0 && linked.length === 0;
  }, [trade, feeRows]);

  const handleCreateSecurity = () => {
    if (!newSecurity.code.trim() || !newSecurity.name.trim()) {
      return;
    }
    createSecurityMutation.mutate(
      {
        code: newSecurity.code.trim(),
        name: newSecurity.name.trim(),
        type: newSecurity.type,
      },
      {
        onSuccess: (sec) => {
          setValue('securityId', sec.id);
          setShowNewSecurity(false);
          setNewSecurity({ code: '', name: '', type: SecurityType.STOCK });
        },
      },
    );
  };

  /** 费用三框 → 有金额的 entries（值 0 不落，C-6） */
  const feeEntries = (values: TradeFormValues): Array<{ amount: string; type: FeeType }> =>
    [
      { amount: values.commission || '0', type: FeeType.COMMISSION },
      { amount: values.stampTax || '0', type: FeeType.STAMP_TAX },
      { amount: values.other || '0', type: FeeType.OTHER },
    ].filter((entry) => Number(entry.amount) > 0);

  /**
   * 统一保存流程（I-01 验收 6，两态对称）：
   * 1. POST / PATCH /security-trades：{ date, side, securityId, quantity, price: 含费单价, fee: 0, note }
   * 2. 重建 FeeRecord：编辑态先 DELETE 该 transactionId 关联的全部费用 → 对 amount>0 逐个 POST /fees
   *    （transactionId = trade.id，scenario = side 映射）
   * 3. 成功后 toast + 刷新（useCreateSecurityTrade/useUpdateSecurityTrade onSuccess 已连带失效计算链路；
   *    费用缓存 ['fees'] 在此手动失效）
   */
  const saveTradeAndFees = async (values: TradeFormValues): Promise<string> => {
    const feeTotalStr = sumMoney([
      values.commission || '0',
      values.stampTax || '0',
      values.other || '0',
    ]);
    const qty = Number(values.quantity);
    const amount = Number(values.tradeAmount);
    const raw =
      (values.side === SecuritySide.BUY_SEC
        ? amount + Number(feeTotalStr)
        : amount - Number(feeTotalStr)) / qty;
    const price = Number(raw.toFixed(6));

    let tradeId: string;
    if (isEdit && trade) {
      await updateMutation.mutateAsync({
        portfolioId,
        id: trade.id,
        payload: {
          securityId: values.securityId,
          date: values.date,
          side: values.side,
          quantity: qty,
          price,
          fee: 0,
          note: values.note || undefined,
        },
      });
      tradeId = trade.id;
    } else {
      const created = await createMutation.mutateAsync({
        portfolioId,
        payload: {
          securityId: values.securityId,
          date: values.date,
          side: values.side,
          quantity: qty,
          price,
          fee: 0,
          note: values.note || undefined,
        },
      });
      tradeId = created.id;
    }

    // ② 重建 FeeRecord（Q-2：仅维护该笔 transactionId 关联的费用组成，删旧插新）
    if (isEdit && trade) {
      const linkedFees = feeRows.filter((f) => f.transactionId === trade.id);
      for (const f of linkedFees) {
        await deleteFeeApi(portfolioId, f.id);
      }
    }
    for (const entry of feeEntries(values)) {
      await createFeeApi(portfolioId, {
        securityId: values.securityId,
        date: values.date,
        amount: entry.amount,
        type: entry.type,
        scenario: scenarioOfSide(values.side),
        transactionId: tradeId,
      });
    }

    // 费用缓存失效（写入本身不参与计算，只失效 ['fees']）
    await queryClient.invalidateQueries({ queryKey: ['fees'] });
    return tradeId;
  };

  const onSubmit = async (values: TradeFormValues): Promise<void> => {
    setSubmitting(true);
    try {
      try {
        await saveTradeAndFees(values);
      } catch {
        // U-5：交易已落库、费用可补录，不阻塞主流程
        toast.error('交易已保存，费用补录失败，请到「分红/费用」区补录');
      }
      reset({
        date: today,
        side: SecuritySide.BUY_SEC,
        securityId: '',
        quantity: '',
        tradeAmount: '',
        commission: '',
        stampTax: '',
        other: '',
        note: '',
      });
      onSuccess?.();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className={className}>
      <div className="space-y-4">
        {/* 方向 */}
        <div className="space-y-2">
          <Label htmlFor="st-side">方向 *</Label>
          <Select
            value={sideValue}
            onValueChange={(v) =>
              setValue(
                'side',
                v as (typeof SecuritySide)[keyof typeof SecuritySide],
              )
            }
          >
            <SelectTrigger id="st-side">
              <SelectValue placeholder="选择方向" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SecuritySide.BUY_SEC}>买入</SelectItem>
              <SelectItem value={SecuritySide.SELL_SEC}>卖出</SelectItem>
            </SelectContent>
          </Select>
          {errors.side && (
            <p className="text-xs text-red-500">{errors.side.message}</p>
          )}
        </div>

        {/* 日期 */}
        <div className="space-y-2">
          <Label htmlFor="st-date">日期 *</Label>
          <Input id="st-date" type="date" max={today} {...register('date')} />
          {errors.date && (
            <p className="text-xs text-red-500">{errors.date.message}</p>
          )}
        </div>

        {/* 标的 */}
        <div className="space-y-2">
          <Label htmlFor="st-security">标的 *</Label>
          <Select
            value={watch('securityId') || ''}
            onValueChange={(v) =>
              v === '__new__' ? setShowNewSecurity(true) : setValue('securityId', v)
            }
            disabled={secLoading}
          >
            <SelectTrigger id="st-security">
              <SelectValue placeholder={secLoading ? '加载中…' : '选择标的'} />
            </SelectTrigger>
            <SelectContent>
              {securities.map((sec) => (
                <SelectItem key={sec.id} value={sec.id}>
                  {sec.name}（{sec.code}）
                </SelectItem>
              ))}
              <SelectItem value="__new__">
                <span className="flex items-center gap-2 text-primary">
                  <Plus className="h-3 w-3" />
                  新建标的
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
          {errors.securityId && (
            <p className="text-xs text-red-500">{errors.securityId.message}</p>
          )}

          {/* 新建标的折叠表单 */}
          {showNewSecurity && (
            <div className="space-y-3 rounded-md border bg-muted/40 p-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">代码 *</Label>
                  <Input
                    placeholder="如 600519"
                    value={newSecurity.code}
                    onChange={(e) =>
                      setNewSecurity((s) => ({ ...s, code: e.target.value }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">名称 *</Label>
                  <Input
                    placeholder="如 贵州茅台"
                    value={newSecurity.name}
                    onChange={(e) =>
                      setNewSecurity((s) => ({ ...s, name: e.target.value }))
                    }
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">类型</Label>
                <Select
                  value={newSecurity.type}
                  onValueChange={(v) =>
                    setNewSecurity((s) => ({
                      ...s,
                      type: v as SecurityType,
                    }))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(SECURITY_TYPE_LABEL).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setShowNewSecurity(false)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleCreateSecurity}
                  disabled={
                    createSecurityMutation.isPending ||
                    !newSecurity.code.trim() ||
                    !newSecurity.name.trim()
                  }
                >
                  {createSecurityMutation.isPending && (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  )}
                  创建并选中
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* 数量 */}
        <div className="space-y-2">
          <Label htmlFor="st-quantity">数量 *</Label>
          <Input
            id="st-quantity"
            type="number"
            step="0.000001"
            min="0"
            placeholder="0"
            {...register('quantity')}
          />
          {errors.quantity && (
            <p className="text-xs text-red-500">{errors.quantity.message}</p>
          )}
        </div>

        {/* 成交额（两态统一输入，I-01） */}
        <div className="space-y-2">
          <Label htmlFor="st-trade-amount">成交额（元）*</Label>
          <Input
            id="st-trade-amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            {...register('tradeAmount')}
          />
          {errors.tradeAmount && (
            <p className="text-xs text-red-500">
              {errors.tradeAmount.message}
            </p>
          )}
        </div>

        {/* 费用三框并列（两态统一，R-6 ✅ 用户拍板；编辑态按 FeeRecord 拆分回显） */}
        <div className="space-y-2">
          <Label>费用（元）</Label>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label htmlFor="st-commission" className="text-xs">
                佣金
              </Label>
              <Input
                id="st-commission"
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                {...register('commission')}
              />
              {errors.commission && (
                <p className="text-xs text-red-500">
                  {errors.commission.message}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="st-stamp-tax" className="text-xs">
                印花税
              </Label>
              <Input
                id="st-stamp-tax"
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                {...register('stampTax')}
              />
              {errors.stampTax && (
                <p className="text-xs text-red-500">
                  {errors.stampTax.message}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="st-other" className="text-xs">
                其他
              </Label>
              <Input
                id="st-other"
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                {...register('other')}
              />
              {errors.other && (
                <p className="text-xs text-red-500">
                  {errors.other.message}
                </p>
              )}
            </div>
          </div>
          <p
            className="rounded-md border bg-muted/40 px-3 py-2 text-sm tabular-nums"
            data-testid="fee-total"
          >
            费用合计（自动）={' '}
            {feeTotal !== null ? formatCurrency(Number(feeTotal)) : '¥0.00'}
          </p>
        </div>

        {/* 含费单价实时展示（K-3，两态统一只读预览） */}
        <div className="space-y-2">
          <Label>成本价（自动，含费）</Label>
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm tabular-nums">
            {derivedPrice !== null ? (
              <>
                {formatCurrency(derivedPrice, 6)}
                <span className="ml-2 text-xs text-muted-foreground">
                  = (成交额
                  {sideValue === SecuritySide.BUY_SEC ? '+' : '−'}
                  费用合计)/数量
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">
                填写数量、成交额与费用后自动计算
              </span>
            )}
          </div>
        </div>

        {/* 旧口径 fee≠0 提示（C-10 / U-1 · I-01：编辑态检测旧口径时提示并入含费单价） */}
        {isLegacy && (
          <p className="flex items-start gap-1.5 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            旧口径记录（费用已并入成交额前录入）：费用已回填至「其他」栏，保存时将自动并入含费单价（成本守恒）。
          </p>
        )}

        {/* 备注 */}
        <div className="space-y-2">
          <Label htmlFor="st-note">备注（可选）</Label>
          <Textarea
            id="st-note"
            placeholder="如：建仓 / 加仓 / 止盈"
            rows={2}
            {...register('note')}
          />
          {errors.note && (
            <p className="text-xs text-red-500">{errors.note.message}</p>
          )}
        </div>

        {/* ⓘ 提示 */}
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          组合内部买卖，不计入出入金现金流；持仓由买卖流水实时推导。费用将按类型记入
          费用记录并与本笔交易关联（含费成本价已生效）。
        </p>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEdit ? '保存' : '录入'}
        </Button>
      </div>
    </form>
  );
}
