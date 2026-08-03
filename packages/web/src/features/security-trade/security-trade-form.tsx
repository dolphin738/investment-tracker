/**
 * features/security-trade/security-trade-form.tsx — 证券买卖录入/编辑弹窗
 *
 * PRD §7.2：方向*(买入/卖出)、日期*、标的*（下拉+新建）、数量*、单价*、
 * 费用、成交额自动（买=数量×单价+费用，卖=数量×单价−费用）、备注。
 * ⓘ 组合内部买卖，不计入出入金现金流。
 */

import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Info, Loader2, Plus } from 'lucide-react';
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
import { toIsoDate } from '@/lib/constants';
import { SecuritySide } from '@investment-tracker/shared';
import { SecurityType } from '@/api/types';
import { formatCurrency } from '@/lib/utils';
import type { SecurityTradeResponse } from '@/api/types';

const tradeSchema = z.object({
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
  price: z
    .string()
    .min(1, '请输入单价')
    .refine((v) => Number(v) > 0, '单价必须大于 0'),
  fee: z
    .string()
    .optional()
    .refine((v) => !v || Number(v) >= 0, '费用不能为负'),
  note: z.string().max(200, '备注最多 200 字').optional(),
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
  const [newSecurity, setNewSecurity] = useState({
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
      price: '',
      fee: '',
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
        price: trade.price,
        fee: trade.fee,
        note: trade.note ?? '',
      });
    } else {
      reset({
        date: today,
        side: SecuritySide.BUY_SEC,
        securityId: '',
        quantity: '',
        price: '',
        fee: '',
        note: '',
      });
    }
  }, [trade, reset, today]);

  const sideValue = watch('side');
  const qtyValue = watch('quantity');
  const priceValue = watch('price');
  const feeValue = watch('fee');

  /** 自动成交额：买 = 数量×单价 + 费用；卖 = 数量×单价 − 费用 */
  const tradeAmount = useMemo(() => {
    const qty = Number(qtyValue);
    const price = Number(priceValue);
    if (!qtyValue || !priceValue || Number.isNaN(qty) || Number.isNaN(price)) {
      return null;
    }
    const fee = Number.isNaN(Number(feeValue)) ? 0 : Number(feeValue) || 0;
    const raw =
      sideValue === SecuritySide.BUY_SEC ? qty * price + fee : qty * price - fee;
    if (raw <= 0) return null;
    return raw;
  }, [qtyValue, priceValue, feeValue, sideValue]);

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

  const onSubmit = (values: TradeFormValues) => {
    setSubmitting(true);
    const payload = {
      securityId: values.securityId,
      date: values.date,
      side: values.side,
      quantity: Number(values.quantity),
      price: Number(values.price),
      fee: Number(values.fee) || 0,
      note: values.note || undefined,
    };
    if (isEdit && trade) {
      updateMutation.mutate(
        { portfolioId, id: trade.id, payload },
        {
          onSettled: () => setSubmitting(false),
          onSuccess: () => onSuccess?.(),
        },
      );
    } else {
      createMutation.mutate(
        { portfolioId, payload },
        {
          onSettled: () => setSubmitting(false),
          onSuccess: () => {
            reset({
              date: today,
              side: SecuritySide.BUY_SEC,
              securityId: '',
              quantity: '',
              price: '',
              fee: '',
              note: '',
            });
            onSuccess?.();
          },
        },
      );
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

        {/* 数量 + 单价 */}
        <div className="grid grid-cols-2 gap-3">
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
          <div className="space-y-2">
            <Label htmlFor="st-price">单价（元）*</Label>
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
        </div>

        {/* 费用 */}
        <div className="space-y-2">
          <Label htmlFor="st-fee">费用（元）</Label>
          <Input
            id="st-fee"
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            {...register('fee')}
          />
          {errors.fee && (
            <p className="text-xs text-red-500">{errors.fee.message}</p>
          )}
        </div>

        {/* 自动成交额 */}
        <div className="space-y-2">
          <Label>成交额（自动）</Label>
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm tabular-nums">
            {tradeAmount !== null ? (
              <>
                ¥{formatCurrency(tradeAmount)}
                <span className="ml-2 text-xs text-muted-foreground">
                  = 数量×单价
                  {sideValue === SecuritySide.BUY_SEC ? '+' : '−'}费用
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">
                填写数量与单价后自动计算
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
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          组合内部买卖，不计入出入金现金流；持仓由买卖流水实时推导。
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
