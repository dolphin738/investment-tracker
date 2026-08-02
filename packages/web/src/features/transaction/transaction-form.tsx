/**
 * features/transaction/transaction-form.tsx — 交易录入表单
 *
 * 受控组件：通过 defaultTransaction 控制是新建还是编辑模式。
 * React Hook Form + Zod 校验。
 *
 * 🆕 T05：新增 securityId / quantity / price / fee 可选字段
 *       - securityId 下拉选择器（从 API 加载标的列表）
 *       - 自动推算 amount = quantity × price ± fee
 */

import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
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
import { useCreateTransaction, useUpdateTransaction } from '@/hooks/use-transactions';
import { useSecurities } from '@/hooks/use-securities';
import { toIsoDate } from '@/lib/constants';
import { TransactionType } from '@investment-tracker/shared';
import type { TransactionResponse } from '@/api/types';

/** Zod 校验 schema */
const transactionSchema = z.object({
  date: z
    .string()
    .min(1, '请选择日期')
    .refine((v) => {
      const today = toIsoDate(new Date());
      return v <= today;
    }, '日期不能为未来'),
  type: z.nativeEnum(TransactionType),
  amount: z
    .string()
    .min(1, '请输入金额')
    .refine((v) => Number(v) > 0, '金额必须大于 0'),
  /** 🆕 关联标的（可选） */
  securityId: z.string().optional(),
  /** 🆕 交易数量（可选） */
  quantity: z
    .string()
    .optional()
    .refine((v) => !v || Number(v) >= 0, '数量不能为负'),
  /** 🆕 成交单价（可选） */
  price: z
    .string()
    .optional()
    .refine((v) => !v || Number(v) >= 0, '单价不能为负'),
  /** 🆕 手续费（可选） */
  fee: z
    .string()
    .optional()
    .refine((v) => !v || Number(v) >= 0, '费用不能为负'),
  note: z.string().max(200, '备注最多 200 字').optional(),
});

type TransactionFormValues = z.infer<typeof transactionSchema>;

export interface TransactionFormProps {
  portfolioId: string;
  /** 传入则编辑，否则新建 */
  transaction?: TransactionResponse | null;
  /** 提交成功后回调（用于关闭对话框等） */
  onSuccess?: () => void;
  className?: string;
}

export function TransactionForm({
  portfolioId,
  transaction,
  onSuccess,
  className,
}: TransactionFormProps): JSX.Element {
  const isEdit = Boolean(transaction);
  const createMutation = useCreateTransaction();
  const updateMutation = useUpdateTransaction();
  const today = toIsoDate(new Date());
  const [submitting, setSubmitting] = useState(false);

  // 🆕 加载标的列表
  const { data: securities = [], isLoading: secLoading } = useSecurities(portfolioId);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<TransactionFormValues>({
    resolver: zodResolver(transactionSchema),
    defaultValues: {
      date: today,
      type: TransactionType.BUY,
      amount: '',
      securityId: '',
      quantity: '',
      price: '',
      fee: '',
      note: '',
    },
  });

  useEffect(() => {
    if (transaction) {
      reset({
        date: transaction.date,
        type: transaction.type as typeof TransactionType.BUY | typeof TransactionType.SELL,
        amount: transaction.amount,
        securityId: transaction.securityId ?? '',
        quantity: transaction.quantity ?? '',
        price: transaction.price ?? '',
        fee: transaction.fee ?? '',
        note: transaction.note ?? '',
      });
    } else {
      reset({
        date: today,
        type: TransactionType.BUY,
        amount: '',
        securityId: '',
        quantity: '',
        price: '',
        fee: '',
        note: '',
      });
    }
  }, [transaction, reset, today]);

  const typeValue = watch('type');
  const qtyValue = watch('quantity');
  const priceValue = watch('price');
  const feeValue = watch('fee');

  /** 🆕 自动推算金额：存入 = qty × price + fee，取出 = qty × price − fee */
  const suggestedAmount = useMemo(() => {
    const qty = Number(qtyValue);
    const price = Number(priceValue);
    const fee = Number(feeValue);
    if (!qtyValue || !priceValue || Number.isNaN(qty) || Number.isNaN(price)) return null;
    const base = qty * price;
    const feeNum = Number.isNaN(fee) ? 0 : fee;
    const raw = typeValue === TransactionType.BUY ? base + feeNum : base - feeNum;
    if (raw <= 0) return null;
    return raw.toFixed(2);
  }, [qtyValue, priceValue, feeValue, typeValue]);

  const handleSuggestedClick = () => {
    if (suggestedAmount) {
      setValue('amount', suggestedAmount);
    }
  };

  const onSubmit = (values: TransactionFormValues) => {
    setSubmitting(true);
    const payload = {
      date: values.date,
      type: values.type,
      amount: values.amount,
      securityId: values.securityId || undefined,
      quantity: values.quantity || undefined,
      price: values.price || undefined,
      fee: values.fee || undefined,
      note: values.note || undefined,
    };
    if (isEdit && transaction) {
      updateMutation.mutate(
        { portfolioId, id: transaction.id, payload },
        {
          onSettled: () => setSubmitting(false),
          onSuccess: () => {
            onSuccess?.();
          },
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
              type: TransactionType.BUY,
              amount: '',
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
        {/* 交易类型 */}
        <div className="space-y-2">
          <Label>交易类型</Label>
          <Select
            value={typeValue}
            onValueChange={(v) => setValue('type', v as typeof TransactionType.BUY | typeof TransactionType.SELL)}
          >
            <SelectTrigger>
              <SelectValue placeholder="选择交易类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TransactionType.BUY}>存入</SelectItem>
              <SelectItem value={TransactionType.SELL}>取出</SelectItem>
            </SelectContent>
          </Select>
          {errors.type && (
            <p className="text-xs text-red-500">{errors.type.message}</p>
          )}
        </div>

        {/* 交易日期 */}
        <div className="space-y-2">
          <Label htmlFor="tx-date">交易日期</Label>
          <Input id="tx-date" type="date" max={today} {...register('date')} />
          {errors.date && (
            <p className="text-xs text-red-500">{errors.date.message}</p>
          )}
        </div>

        {/* 🆕 标的选择 */}
        <div className="space-y-2">
          <Label htmlFor="tx-security">标的（可选）</Label>
          <Select
            value={watch('securityId') || ''}
            onValueChange={(v) => setValue('securityId', v === '__none__' ? '' : v)}
            disabled={secLoading}
          >
            <SelectTrigger id="tx-security">
              <SelectValue placeholder={secLoading ? '加载中…' : '选择标的'} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">不关联标的</SelectItem>
              {securities.map((sec) => (
                <SelectItem key={sec.id} value={sec.id}>
                  {sec.name}（{sec.code}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.securityId && (
            <p className="text-xs text-red-500">{errors.securityId.message}</p>
          )}
        </div>

        {/* 🆕 数量 + 单价（并排） */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="tx-quantity">数量（可选）</Label>
            <Input
              id="tx-quantity"
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
            <Label htmlFor="tx-price">单价（可选）</Label>
            <Input
              id="tx-price"
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

        {/* 🆕 手续费 */}
        <div className="space-y-2">
          <Label htmlFor="tx-fee">手续费（可选，已含在金额内）</Label>
          <Input
            id="tx-fee"
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

        {/* 交易金额 */}
        <div className="space-y-2">
          <Label htmlFor="tx-amount">交易金额（元）</Label>
          <Input
            id="tx-amount"
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            {...register('amount')}
          />
          {errors.amount && (
            <p className="text-xs text-red-500">{errors.amount.message}</p>
          )}
          {/* 🆕 自动推算提示 */}
          {suggestedAmount && suggestedAmount !== watch('amount') && (
            <p className="text-xs text-amber-600">
              💡 按 数量×单价{typeValue === TransactionType.BUY ? '+' : '−'}费用 推算为{' '}
              <button
                type="button"
                className="underline hover:no-underline"
                onClick={handleSuggestedClick}
              >
                ¥{Number(suggestedAmount).toLocaleString('zh-CN', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </button>
            </p>
          )}
        </div>

        {/* 备注 */}
        <div className="space-y-2">
          <Label htmlFor="tx-note">备注（可选）</Label>
          <Textarea
            id="tx-note"
            placeholder="如：定投 / 止盈 / 加仓"
            rows={2}
            {...register('note')}
          />
          {errors.note && (
            <p className="text-xs text-red-500">{errors.note.message}</p>
          )}
        </div>
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
