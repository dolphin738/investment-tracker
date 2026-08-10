/**
 * features/cashflow/cash-balance-form.tsx — 现金余额录入/编辑表单（弹窗内容）
 *
 * 出入金页改版：现金余额从「页面内联输入框」升级为弹窗录入，
 * **新增与编辑复用同一组件**（编辑 = 按生效日 upsert 覆盖同一条记录）。
 *
 * 语义约定：
 * - 后端 `POST /cash-balances` 是 upsert（同 `asOf` 覆盖旧值），因此编辑态**锁定生效日**：
 *   若允许改日期，会变成「新建一条 + 旧记录残留」，与用户预期的「改这一条」不符。
 *   确需改日期 → 删除后重新录入（删除同样触发重算）。
 * - 金额允许 0（清空现金），但不允许负数；日期不能为未来（与后端 D1 校验同口径）。
 * - 提交失败**不关闭弹窗**：保留用户输入并就地显示后端可读错误（含业务码文案）；
 *   全局 toast 由 api-client 拦截器统一负责，此处不重复 toast（避免双弹）。
 */

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useUpsertCashBalance } from '@/hooks/use-cash-balances';
import { resolveApiErrorMessage } from '@/lib/api-error-message';
import { toIsoDate } from '@/lib/constants';
import { formatDate } from '@/lib/utils';
import type { CashBalanceResponse } from '@/api/types';

const cashBalanceSchema = z.object({
  asOf: z
    .string()
    .min(1, '请选择生效日期')
    .refine((v) => v <= toIsoDate(new Date()), '生效日期不能为未来'),
  amount: z
    .string()
    .min(1, '请输入金额')
    .refine((v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0;
    }, '金额必须为不小于 0 的数字'),
  note: z.string().max(200, '备注最多 200 字').optional(),
});

type CashBalanceFormValues = z.infer<typeof cashBalanceSchema>;

export interface CashBalanceFormProps {
  portfolioId: string;
  /** 传入则为编辑（按生效日覆盖该条），否则为新增 */
  balance?: CashBalanceResponse | null;
  /** 保存成功回调（父级据此关闭弹窗） */
  onSuccess?: (result: CashBalanceResponse) => void;
  className?: string;
}

export function CashBalanceForm({
  portfolioId,
  balance,
  onSuccess,
  className,
}: CashBalanceFormProps): JSX.Element {
  const isEdit = Boolean(balance);
  const upsertMutation = useUpsertCashBalance();
  const today = toIsoDate(new Date());
  /** 提交失败的就地错误（弹窗不关，输入不丢） */
  const [submitError, setSubmitError] = useState('');

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CashBalanceFormValues>({
    resolver: zodResolver(cashBalanceSchema),
    defaultValues: {
      asOf: balance?.asOf ?? today,
      amount: balance?.amount ?? '',
      note: balance?.note ?? '',
    },
  });

  // 复用同一弹窗在「新增 ↔ 编辑某条」之间切换时重置表单与错误
  useEffect(() => {
    setSubmitError('');
    if (balance) {
      reset({ asOf: balance.asOf, amount: balance.amount, note: balance.note ?? '' });
    } else {
      reset({ asOf: today, amount: '', note: '' });
    }
  }, [balance, reset, today]);

  const onSubmit = (values: CashBalanceFormValues): void => {
    setSubmitError('');
    upsertMutation.mutate(
      {
        portfolioId,
        payload: {
          // 编辑态生效日锁定为原记录的 asOf（表单未渲染该输入，值取自 defaultValues）
          asOf: isEdit && balance ? balance.asOf : values.asOf,
          amount: Number(values.amount),
          note: values.note || undefined,
        },
      },
      {
        onSuccess: (data) => {
          if (!isEdit) {
            reset({ asOf: today, amount: '', note: '' });
          }
          onSuccess?.(data);
        },
        onError: (error) => {
          setSubmitError(
            resolveApiErrorMessage(error, '现金余额保存失败，请稍后重试'),
          );
        },
      },
    );
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className={className}>
      <div className="space-y-4">
        {/* 生效日期：新增可选，编辑锁定（upsert 按 asOf 覆盖，改日期会变成新建） */}
        <div className="space-y-2">
          <Label htmlFor="cb-as-of">生效日期</Label>
          {isEdit && balance ? (
            <>
              <p
                id="cb-as-of"
                className="flex h-9 items-center rounded-md border border-input bg-muted/40 px-3 font-mono text-sm"
              >
                {formatDate(balance.asOf)}
              </p>
              <p className="text-xs text-muted-foreground">
                生效日不可修改；如需改日期请删除该条后重新录入。
              </p>
            </>
          ) : (
            <Input id="cb-as-of" type="date" max={today} {...register('asOf')} />
          )}
          {errors.asOf && (
            <p className="text-xs text-red-500">{errors.asOf.message}</p>
          )}
        </div>

        {/* 金额（允许 0 = 清空现金；不允许负数） */}
        <div className="space-y-2">
          <Label htmlFor="cb-amount">金额（元）</Label>
          <Input
            id="cb-amount"
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

        {/* 备注 */}
        <div className="space-y-2">
          <Label htmlFor="cb-note">备注（可选）</Label>
          <Textarea
            id="cb-note"
            placeholder="如：券商账户可用余额对账"
            rows={2}
            {...register('note')}
          />
          {errors.note && (
            <p className="text-xs text-red-500">{errors.note.message}</p>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          保存后自该生效日起前向沿用，并触发净值 / XIRR 重算。
        </p>

        {/* 提交失败：就地保留原因，弹窗不关闭（不吞错误） */}
        {submitError && (
          <p
            role="alert"
            className="flex items-start gap-1.5 rounded-md bg-red-50 p-2 text-xs text-red-600 dark:bg-red-950/30"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{submitError}</span>
          </p>
        )}
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button type="submit" disabled={upsertMutation.isPending}>
          {upsertMutation.isPending && (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          )}
          {isEdit ? '保存' : '录入'}
        </Button>
      </div>
    </form>
  );
}
