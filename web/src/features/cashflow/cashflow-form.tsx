/**
 * features/cashflow/cashflow-form.tsx — 出入金录入/编辑弹窗表单
 *
 * PRD §7.1：录入/编辑弹窗仅含 类型(存入/取出) / 日期 / 金额 / 备注，
 * **不含证券明细字段** —— 出入金与证券买卖是两回事（C-10）。
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
import { CashFlowType } from '@/lib/types';
import type { TransactionResponse } from '@/api/types';

const cashflowSchema = z.object({
  date: z
    .string()
    .min(1, '请选择日期')
    .refine((v) => v <= toIsoDate(new Date()), '日期不能为未来'),
  type: z.nativeEnum(CashFlowType),
  amount: z
    .string()
    .min(1, '请输入金额')
    .refine((v) => Number(v) > 0, '金额必须大于 0'),
  note: z.string().max(200, '备注最多 200 字').optional(),
});

type CashflowFormValues = z.infer<typeof cashflowSchema>;

export interface CashflowFormProps {
  portfolioId: string;
  /** 传入则编辑，否则新建 */
  cashflow?: TransactionResponse | null;
  /**
   * 提交成功后回调（携带 mutation 响应，供页面读取重算结果/关闭弹窗）。
   * 重算 toast 与 FLOW-P0-06 软提示由 use-transactions 的 mutation onSuccess 统一触发，
   * 此处仅透传响应，不重复弹 toast。
   */
  onSuccess?: (result?: TransactionResponse) => void;
  className?: string;
}

export function CashflowForm({
  portfolioId,
  cashflow,
  onSuccess,
  className,
}: CashflowFormProps): JSX.Element {
  const isEdit = Boolean(cashflow);
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
  } = useForm<CashflowFormValues>({
    resolver: zodResolver(cashflowSchema),
    defaultValues: {
      date: today,
      // 编辑态首帧即按 cashflow.type 回填（避免类型栏空白「选择类型」）；新建默认存入
      type: cashflow?.type ?? CashFlowType.BUY,
      amount: '',
      note: '',
    },
  });

  useEffect(() => {
    if (cashflow) {
      reset({
        date: cashflow.date,
        type: cashflow.type as (typeof CashFlowType)[keyof typeof CashFlowType],
        amount: cashflow.amount,
        note: cashflow.note ?? '',
      });
    } else {
      reset({ date: today, type: CashFlowType.BUY, amount: '', note: '' });
    }
  }, [cashflow, reset, today]);

  const typeValue = watch('type');

  const onSubmit = (values: CashflowFormValues) => {
    setSubmitting(true);
    const payload = {
      date: values.date,
      type: values.type,
      amount: values.amount,
      note: values.note || undefined,
    };
    if (isEdit && cashflow) {
      updateMutation.mutate(
        { portfolioId, id: cashflow.id, payload },
        {
          onSettled: () => setSubmitting(false),
          onSuccess: (data) => onSuccess?.(data),
        },
      );
    } else {
      createMutation.mutate(
        { portfolioId, payload },
        {
          onSettled: () => setSubmitting(false),
          onSuccess: (data) => {
            reset({ date: today, type: CashFlowType.BUY, amount: '', note: '' });
            onSuccess?.(data);
          },
        },
      );
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className={className}>
      <div className="space-y-4">
        {/* 类型 */}
        <div className="space-y-2">
          <Label htmlFor="cf-type">类型</Label>
          <Select
            value={typeValue || cashflow?.type}
            onValueChange={(v) =>
              setValue(
                'type',
                v as (typeof CashFlowType)[keyof typeof CashFlowType],
              )
            }
          >
            <SelectTrigger id="cf-type">
              <SelectValue placeholder="选择类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CashFlowType.BUY}>存入</SelectItem>
              <SelectItem value={CashFlowType.SELL}>取出</SelectItem>
            </SelectContent>
          </Select>
          {errors.type && (
            <p className="text-xs text-red-500">{errors.type.message}</p>
          )}
        </div>

        {/* 日期 */}
        <div className="space-y-2">
          <Label htmlFor="cf-date">日期</Label>
          <Input id="cf-date" type="date" max={today} {...register('date')} />
          {errors.date && (
            <p className="text-xs text-red-500">{errors.date.message}</p>
          )}
        </div>

        {/* 金额 */}
        <div className="space-y-2">
          <Label htmlFor="cf-amount">金额（元）</Label>
          <Input
            id="cf-amount"
            type="number"
            step="0.01"
            min="0.01"
            placeholder="0.00"
            {...register('amount')}
          />
          {errors.amount && (
            <p className="text-xs text-red-500">{errors.amount.message}</p>
          )}
        </div>

        {/* 备注 */}
        <div className="space-y-2">
          <Label htmlFor="cf-note">备注（可选）</Label>
          <Textarea
            id="cf-note"
            placeholder="如：工资入金 / 生活支出"
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
