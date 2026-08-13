/**
 * features/security-trade/security-trade-form.tsx — 证券买卖录入/编辑弹窗（I-01 编辑界面统一）
 *
 * 🆕 I-01（增量 PRD）：录入 / 编辑共用**同一 schema + 同一布局**，仅初始值与提交目标不同。
 * - 统一字段与顺序：方向 → 日期 → 标的 → 数量 → 成交额 → 费用三框（佣金/印花税/其他）
 *   → 成本价（含费单价，只读预览）→ 备注
 * - 统一公式（K-3，买入/卖出同式）：
 *   - 买入：costPrice = (成交额 + 费用合计) / 数量
 *   - 卖出：costPrice = (成交额 − 费用合计) / 数量；费用合计 > 成交额 → 阻止（C-7 前端闸）
 * - 编辑态回填：费用三框直接取自 trade.commission/stampTax/other；成交额按口径回填
 *   `q×costPrice −/+ feeTotal`（含费单价金融算法不变，决策 B：costPrice 仅是 price 重命名）。
 *
 * ⓘ 组合内部买卖，不计入出入金现金流。INC-04 物理并表：费用明细（佣金/印花税/其他）
 * 直接承载于 security_trades 一行，feeTotal = 三列之和（后端冗余展示列，前端按公式提交）。
 */

import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { sumMoney } from '@/lib/types';
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
import { useSecurities, useResolveSecurity } from '@/hooks/use-securities';
import { toast } from 'sonner';
import { toIsoDate } from '@/lib/constants';
// SecurityType 与 SecuritySide 同源：唯一定义在 shared，前后端共用（Q-3）
import { SecuritySide, SecurityType } from '@/lib/types';
import { formatCurrency } from '@/lib/utils';
import type {
  CreateSecurityTradeRequest,
  SecurityTradeResponse,
} from '@/api/types';
import { SecuritySearchCombobox } from '@/components/security/security-search-combobox';
import type { SecurityMaster } from '@/api/security-master.api';

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
 * 成交额允许最多 6 位小数：录入态用户通常输入 2 位金额；编辑态回填 `q×costPrice −/+ feeTotal`
 * 可能产生 3~6 位小数（costPrice 为 6 位小数），若截断到 2 位会破坏「不改动即成本守恒」。
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
  // 卖出费用合计 > 成交额 → 阻止（C-7 前端闸 + 后端 costPrice>0 DTO 兜底）
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
  const { data: securities = [], isLoading: secLoading } = useSecurities(portfolioId);
  const today = toIsoDate(new Date());
  const [submitting, setSubmitting] = useState(false);

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
      // 编辑态首帧即按 trade.side 回填（避免方向栏空白「选择方向」）；新建默认买入
      side: trade?.side ?? SecuritySide.BUY_SEC,
      securityId: '',
      quantity: '',
      tradeAmount: '',
      commission: '',
      stampTax: '',
      other: '',
      note: '',
    },
  });

  /**
   * 编辑态回填（I-01 验收 3/4）：
   * - 费用三框直接取自 trade.commission/stampTax/other（INC-04 物理并表，无独立费用表）
   * - 成交额：新口径（含费单价口径）`q×costPrice −/+ feeTotal`
   *   （costPrice 为含费单价，`tradeAmount = qty*costPrice −/+ feeTotal` 倒推，金融算法不变）
   */
  useEffect(() => {
    if (trade) {
      const feeTotal = Number(trade.feeTotal);
      const baseAmount = Number(trade.quantity) * Number(trade.costPrice);
      const tradeAmount =
        trade.side === SecuritySide.BUY_SEC
          ? baseAmount - feeTotal
          : baseAmount + feeTotal;
      reset({
        date: trade.date,
        side: trade.side as (typeof SecuritySide)[keyof typeof SecuritySide],
        securityId: trade.securityId,
        quantity: trade.quantity,
        tradeAmount: toPrecision6(tradeAmount),
        commission: trade.commission || '',
        stampTax: trade.stampTax || '',
        other: trade.other || '',
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
  }, [trade, reset, today]);

  const sideValue = watch('side');
  const securityIdValue = watch('securityId');
  const qtyValue = watch('quantity');

  /**
   * 标的下拉的受控值（INC-02）。
   *
   * 编辑态首帧 `securities` 往往还没到（`useSecurities` 异步），此时表单的
   * `securityId` 虽已由回填 effect 写入，但 Radix Select 找不到对应
   * `SelectItem` → 触发器回落 placeholder「选择标的」，看起来像「没回填」。
   * 这里让受控值**恒含** `trade.securityId`，与下方保底选项配合，保证
   * 任何时刻 value 都能命中一个已渲染的选项。
   */
  const selectedSecurityId = securityIdValue || trade?.securityId || '';

  /**
   * 当前选中标的的展示文本（编辑态回显，INC-02 保底语义）：
   * - 列表已到且含当前标的 → 「名称（代码）」；
   * - 列表未到 → 「当前标的（加载中…）」；
   * - 列表已到但当前标的不在 → 「当前标的（已不在可选列表）」。
   * 传入 SecuritySearchCombobox 的 value，保证编辑态任何时刻都能正确回显。
   */
  const selectedSecurityLabel = useMemo(() => {
    if (!selectedSecurityId) return '';
    const found = securities.find((s) => s.id === selectedSecurityId);
    if (found) return `${found.name}（${found.code}）`;
    return secLoading ? '当前标的（加载中…）' : '当前标的（已不在可选列表）';
  }, [securities, selectedSecurityId, secLoading]);

  /** 选中系统主数据 → resolve 懒实例化为组合标的，回填 securityId（§7 ③ / §10） */
  const resolveSecurityMutation = useResolveSecurity(portfolioId);
  const handleSelectMaster = (master: SecurityMaster): void => {
    resolveSecurityMutation.mutate(
      {
        code: master.code,
        name: master.name,
        type: master.type ? (master.type as SecurityType) : undefined,
        exchange: master.exchange ?? undefined,
      },
      {
        onSuccess: (res) => setValue('securityId', res.id, { shouldValidate: true }),
      },
    );
  };

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

  /** 成本价（含费单价，只读实时预览，两态一致，K-3）：买入=(成交额+合计)/数量；卖出=(成交额−合计)/数量 */
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

  /**
   * 统一保存流程（I-01 验收 6，两态对称）：
   * 提交单笔 /security-trades，INC-04 物理并表承载：
   * { date, side, securityId, quantity, costPrice（含费单价）, commission, stampTax, other, feeTotal }。
   * 费用合计 feeTotal = 三列之和（前端按公式提交，后端以三列之和覆盖冗余展示列）。
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
    const costPrice = Number(raw.toFixed(6));

    const payload: CreateSecurityTradeRequest = {
      securityId: values.securityId,
      date: values.date,
      side: values.side,
      quantity: qty,
      costPrice,
      commission: Number(values.commission || '0'),
      stampTax: Number(values.stampTax || '0'),
      other: Number(values.other || '0'),
      feeTotal: Number(feeTotalStr),
      note: values.note || undefined,
    };

    let tradeId: string;
    if (isEdit && trade) {
      await updateMutation.mutateAsync({ portfolioId, id: trade.id, payload });
      tradeId = trade.id;
    } else {
      const created = await createMutation.mutateAsync({ portfolioId, payload });
      tradeId = created.id;
    }
    return tradeId;
  };

  const onSubmit = async (values: TradeFormValues): Promise<void> => {
    setSubmitting(true);
    try {
      await saveTradeAndFees(values);
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
    } catch {
      toast.error('保存失败，请稍后重试');
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
            value={sideValue ?? trade?.side}
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

        {/* 标的：证券搜索选择（§10，不再支持「新建标的」） */}
        <div className="space-y-2">
          <Label htmlFor="st-security">标的 *</Label>
          <SecuritySearchCombobox
            id="st-security"
            value={selectedSecurityLabel}
            placeholder={secLoading ? '加载中…' : '搜索代码 / 名称 / 拼音首字母'}
            disabled={secLoading && !selectedSecurityId}
            onSelect={handleSelectMaster}
          />
          {errors.securityId && (
            <p className="text-xs text-red-500">{errors.securityId.message}</p>
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

        {/* 费用三框并列（两态统一，R-6 ✅ 用户拍板） */}
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

        {/* 成本价实时展示（K-3，两态统一只读预览） */}
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
          组合内部买卖，不计入出入金现金流；持仓由买卖流水实时推导。佣金 / 印花税 /
          其他费用已并入含费成本价（INC-04 物理并表至证券买卖流水）。
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
