/**
 * features/security-trade/security-trade-form.tsx — 证券买卖录入/编辑弹窗
 *
 * 增量设计 R-6/R-7/R-8（含费成本价 + 费用拆分落 FeeRecord）：
 * - **录入态**：用户输入 成交额 + 佣金/印花税/其他 三框并列 → 费用合计自动求和 →
 *   自动计算含费单价并展示 → 提交时先 POST /security-trades（price=含费单价、fee=0）
 *   拿 trade.id → 对 amount>0 的类型逐个 POST /fees（transactionId=trade.id）
 * - **编辑态**（U-4/C-10）：不展示费用三框、不重算 FeeRecord；仅保留「数量 + 含费单价」
 *   直编 + 只读换算成交额；存量 fee≠0 显示口径提示
 * - 公式（K-3）：买入 price=(成交额+费用合计)/数量；卖出 price=(成交额−费用合计)/数量；
 *   卖出费用合计 > 成交额 → 阻止提交（C-7 前端闸 + 后端 price>0 DTO 兜底）
 *
 * ⓘ 组合内部买卖，不计入出入金现金流。
 */

import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Info, Loader2, Plus } from 'lucide-react';
import { sumMoney } from '@investment-tracker/shared';
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
import { createFee as createFeeApi } from '@/api/fee.api';
import { toast } from 'sonner';
import { toIsoDate } from '@/lib/constants';
// SecurityType 与 SecuritySide 同源：唯一定义在 shared，前后端共用（Q-3）
import { SecuritySide, SecurityType } from '@investment-tracker/shared';
import { formatCurrency } from '@/lib/utils';
import { FeeType } from '@/api/types';
import type { SecurityTradeResponse } from '@/api/types';

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

/** 录入态：成交额 + 三费用框 → 含费单价（R-8） */
const createTradeSchema = z
  .object({
    ...baseFields,
    tradeAmount: z
      .string()
      .min(1, '请输入成交额')
      .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), '成交额最多 2 位小数')
      .refine((v) => Number(v) > 0, '成交额必须大于 0'),
    commission: feeFieldSchema,
    stampTax: feeFieldSchema,
    other: feeFieldSchema,
    // 编辑态专用字段在录入态不参与（避免 zod 校验）
    price: z.string().optional(),
  })
  // 卖出费用合计 > 成交额 → 阻止（C-7）
  .superRefine((data, ctx) => {
    if (data.side !== SecuritySide.SELL_SEC) return;
    const feeTotal = sumMoney([data.commission || '0', data.stampTax || '0', data.other || '0']);
    if (Number(feeTotal) > Number(data.tradeAmount || '0')) {
      ctx.addIssue({
        code: 'custom',
        path: ['tradeAmount'],
        message: '费用合计不能超过成交额',
      });
    }
  });

/** 编辑态：数量 + 含费单价 直编（U-4），无费用三框 */
const editTradeSchema = z.object({
  ...baseFields,
  tradeAmount: z.string().optional(),
  commission: z.string().optional(),
  stampTax: z.string().optional(),
  other: z.string().optional(),
  price: z
    .string()
    .min(1, '请输入含费单价')
    .refine((v) => Number(v) > 0, '单价必须大于 0'),
});

type TradeFormValues = z.infer<typeof createTradeSchema>;

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
  const today = toIsoDate(new Date());
  const [submitting, setSubmitting] = useState(false);
  // 新建标的折叠表单状态
  const [showNewSecurity, setShowNewSecurity] = useState(false);
  // 显式标注 type 为 SecurityType（shared 的 as const 联合类型），
  // 否则会被推断成字面量 'STOCK'，下拉切换其他类型时赋值失败
  const [newSecurity, setNewSecurity] = useState<{
    code: string;
    name: string;
    type: SecurityType;
  }>({
    code: '',
    name: '',
    type: SecurityType.STOCK,
  });

  // 表单组件随 trade 变化整体重挂载（弹窗条件渲染），schema 一次确定即可
  const schema = (isEdit ? editTradeSchema : createTradeSchema) as z.ZodType<
    TradeFormValues
  >;

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<TradeFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      date: today,
      side: SecuritySide.BUY_SEC,
      securityId: '',
      quantity: '',
      tradeAmount: '',
      commission: '',
      stampTax: '',
      other: '',
      price: '',
      note: '',
    },
  });

  useEffect(() => {
    if (trade) {
      reset({
        date: trade.date,
        side: trade.side as (typeof SecuritySide)[keyof typeof SecuritySide],
        securityId: trade.securityId,
        quantity: trade.quantity,
        tradeAmount: '',
        commission: '',
        stampTax: '',
        other: '',
        price: trade.price,
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
        price: '',
        note: '',
      });
    }
  }, [trade, reset, today]);

  const sideValue = watch('side');
  const qtyValue = watch('quantity');
  const priceValue = watch('price');
  const tradeAmountValue = watch('tradeAmount');
  const commissionValue = watch('commission');
  const stampTaxValue = watch('stampTax');
  const otherValue = watch('other');

  /** 费用合计（录入态自动求和，整数分运算；输入未成型时 null） */
  const feeTotal = useMemo(() => {
    if (isEdit) return null;
    const inputs = [commissionValue, stampTaxValue, otherValue];
    if (inputs.some((v) => v && !/^\d+(\.\d{1,2})?$/.test(v))) return null;
    return sumMoney(inputs.map((v) => v || '0'));
  }, [isEdit, commissionValue, stampTaxValue, otherValue]);

  /** 含费单价（录入态实时计算）：买入=(成交额+合计)/数量；卖出=(成交额−合计)/数量 */
  const derivedPrice = useMemo(() => {
    if (isEdit || feeTotal === null) return null;
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
  }, [isEdit, feeTotal, qtyValue, tradeAmountValue, sideValue]);

  /** 编辑态只读换算成交额 = 数量 × 含费单价 */
  const editAmount = useMemo(() => {
    if (!isEdit) return null;
    const qty = Number(qtyValue);
    const price = Number(priceValue);
    if (!qtyValue || !priceValue || Number.isNaN(qty) || Number.isNaN(price)) {
      return null;
    }
    if (qty <= 0 || price <= 0) return null;
    return qty * price;
  }, [isEdit, qtyValue, priceValue]);

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

  /** 提交录入态：先建 trade 拿 id，再逐个 POST fee（仅 amount>0，C-6） */
  const submitCreate = async (values: TradeFormValues): Promise<void> => {
    const feeTotalStr = sumMoney([
      values.commission || '0',
      values.stampTax || '0',
      values.other || '0',
    ]);
    const qty = Number(values.quantity);
    const amount = Number(values.tradeAmount);
    const raw =
      ((values.side === SecuritySide.BUY_SEC
        ? amount + Number(feeTotalStr)
        : amount - Number(feeTotalStr)) /
        qty);
    const price = Number(raw.toFixed(6));

    // ① 先 POST /security-trades（price=含费单价、fee=0）拿 trade.id（C-4/C-5）
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

    // ② 对 amount>0 的每个类型 POST /fees（transactionId=trade.id；值 0 不落，C-6）
    const feeEntries: Array<{ amount: string; type: FeeType }> = [
      { amount: values.commission || '0', type: FeeType.COMMISSION },
      { amount: values.stampTax || '0', type: FeeType.STAMP_TAX },
      { amount: values.other || '0', type: FeeType.OTHER },
    ];
    try {
      for (const entry of feeEntries) {
        if (Number(entry.amount) > 0) {
          await createFeeApi(portfolioId, {
            securityId: values.securityId,
            date: values.date,
            amount: entry.amount,
            type: entry.type,
            transactionId: created.id,
          });
        }
      }
    } catch {
      // U-5：交易已落库、费用可补录，不阻塞主流程
      toast.error('交易已录入，费用补录失败，请到「分红/费用」区补录');
    }
    // 费用列表缓存由 useCreateSecurityTrade onSuccess 连带失效 ['fees']（K-4 兜底）
  };

  const onSubmit = async (values: TradeFormValues): Promise<void> => {
    setSubmitting(true);
    try {
      if (isEdit && trade) {
        // 编辑态：不展示费用三框、不重算 FeeRecord（U-4）；后端 update 忽略 fee
        await updateMutation.mutateAsync({
          portfolioId,
          id: trade.id,
          payload: {
            securityId: values.securityId,
            date: values.date,
            side: values.side,
            quantity: Number(values.quantity),
            price: Number(values.price),
            note: values.note || undefined,
          },
        });
        onSuccess?.();
        return;
      }
      await submitCreate(values);
      reset({
        date: today,
        side: SecuritySide.BUY_SEC,
        securityId: '',
        quantity: '',
        tradeAmount: '',
        commission: '',
        stampTax: '',
        other: '',
        price: '',
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

        {isEdit ? (
          <>
            {/* 编辑态：含费单价直编（U-4） */}
            <div className="space-y-2">
              <Label htmlFor="st-price">含费单价（元）*</Label>
              <Input
                id="st-price"
                type="number"
                step="0.000001"
                min="0"
                placeholder="0.00"
                {...register('price')}
              />
              {errors.price && (
                <p className="text-xs text-red-500">{errors.price.message}</p>
              )}
            </div>

            {/* 编辑态：只读换算成交额 */}
            <div className="space-y-2">
              <Label>成交额（只读换算 = 数量 × 含费单价）</Label>
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm tabular-nums">
                {editAmount !== null ? (
                  formatCurrency(editAmount)
                ) : (
                  <span className="text-muted-foreground">
                    填写数量与含费单价后自动换算
                  </span>
                )}
              </div>
            </div>

            {/* 存量 fee≠0 口径提示（C-10 / U-1） */}
            {trade && Number(trade.fee) !== 0 && (
              <p className="flex items-start gap-1.5 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                旧口径记录（费用已并入成交额前录入）：编辑不改成本口径，如需费用拆分请删除重录。
              </p>
            )}
          </>
        ) : (
          <>
            {/* 录入态：成交额（用户输入，不再自动算 R-8） */}
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

            {/* 费用三框并列（R-6 ✅ 用户拍板） */}
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

            {/* 含费单价实时展示（K-3） */}
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
          </>
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
