/**
 * features/transaction/transaction-form.tsx — 交易录入表单
 *
 * 受控组件：通过 defaultTransaction 控制是新建还是编辑模式。
 * React Hook Form + Zod 校验：金额 > 0、日期非未来、类型必填。
 */

import { useEffect, useState } from 'react';
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
import { toIsoDate } from '@/lib/constants';
import type { Transaction } from '@investment-tracker/shared';
import { TransactionType } from '@investment-tracker/shared';

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
  note: z.string().max(200, '备注最多 200 字').optional(),
});

type TransactionFormValues = z.infer<typeof transactionSchema>;

export interface TransactionFormProps {
  portfolioId: string;
  /** 传入则编辑，否则新建 */
  transaction?: Transaction | null;
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
      note: '',
    },
  });

  useEffect(() => {
    if (transaction) {
      reset({
        date: transaction.date,
        type: transaction.type,
        amount: transaction.amount,
        note: transaction.note ?? '',
      });
    } else {
      reset({ date: today, type: TransactionType.BUY, amount: '', note: '' });
    }
  }, [transaction, reset, today]);

  const typeValue = watch('type');

  const onSubmit = (values: TransactionFormValues) => {
    setSubmitting(true);
    const payload = {
      date: values.date,
      type: values.type,
      amount: values.amount,
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
            reset({ date: today, type: TransactionType.BUY, amount: '', note: '' });
            onSuccess?.();
          },
        },
      );
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className={className}>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>交易类型</Label>
          <Select
            value={typeValue}
            onValueChange={(v) => setValue('type', v as TransactionType)}
          >
            <SelectTrigger>
              <SelectValue placeholder="选择交易类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TransactionType.BUY}>买入</SelectItem>
              <SelectItem value={TransactionType.SELL}>卖出</SelectItem>
            </SelectContent>
          </Select>
          {errors.type && (
            <p className="text-xs text-red-500">{errors.type.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="tx-date">交易日期</Label>
          <Input id="tx-date" type="date" max={today} {...register('date')} />
          {errors.date && (
            <p className="text-xs text-red-500">{errors.date.message}</p>
          )}
        </div>

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
        </div>

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
