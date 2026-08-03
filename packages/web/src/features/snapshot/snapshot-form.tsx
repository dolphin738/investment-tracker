/**
 * features/snapshot/snapshot-form.tsx — 资产快照录入/编辑表单（PRD §7.3）
 *
 * - 字段：日期（不可未来）/ 总资产* / 持仓市值 / 现金余额 / 备注
 * - 选择日期后展示 ⚠️「该日系统自动计算值为 ¥xxx，保存后将取代」
 * - 编辑语义：
 *   - 手工记录（source=MANUAL）→ PATCH 更新
 *   - 自动记录（source=DERIVED）或无记录 → POST upsert（保存即变手工）
 */

import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useUpsertSnapshot, useUpdateSnapshot } from '@/hooks/use-snapshots';
import { useNavTotalAssetMap } from '@/hooks/use-query-data';
import { toIsoDate } from '@/lib/constants';
import { formatCurrency } from '@/lib/utils';
import type { AssetSnapshot } from '@investment-tracker/shared';

const snapshotSchema = z.object({
  date: z
    .string()
    .min(1, '请选择日期')
    .refine((v) => v <= toIsoDate(new Date()), '日期不能为未来'),
  totalAsset: z
    .string()
    .min(1, '请输入资产总额')
    .refine((v) => Number(v) > 0, '金额必须大于 0'),
  marketValue: z
    .string()
    .optional()
    .refine((v) => !v || Number(v) >= 0, '持仓市值不能为负'),
  cashBalance: z
    .string()
    .optional()
    .refine((v) => !v || Number(v) >= 0, '现金余额不能为负'),
  note: z.string().max(200, '备注最多 200 字').optional(),
});

type SnapshotFormValues = z.infer<typeof snapshotSchema>;

export interface SnapshotFormProps {
  portfolioId: string;
  /** 传入则编辑（DERIVED 行保存后变 MANUAL），否则新建 */
  snapshot?: AssetSnapshot | null;
  onSuccess?: () => void;
  className?: string;
}

export function SnapshotForm({
  portfolioId,
  snapshot,
  onSuccess,
  className,
}: SnapshotFormProps): JSX.Element {
  const today = toIsoDate(new Date());
  const upsertMutation = useUpsertSnapshot();
  const updateMutation = useUpdateSnapshot();
  const isManualEdit = Boolean(snapshot && snapshot.source === 'MANUAL');
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<SnapshotFormValues>({
    resolver: zodResolver(snapshotSchema),
    defaultValues: {
      date: today,
      totalAsset: '',
      marketValue: '',
      cashBalance: '',
      note: '',
    },
  });

  useEffect(() => {
    if (snapshot) {
      reset({
        date: snapshot.date,
        totalAsset: snapshot.totalAsset,
        marketValue: snapshot.marketValue ?? '',
        cashBalance: snapshot.cashBalance ?? '',
        note: snapshot.note ?? '',
      });
    } else {
      reset({
        date: today,
        totalAsset: '',
        marketValue: '',
        cashBalance: '',
        note: '',
      });
    }
  }, [snapshot, reset, today]);

  // 系统自动计算值映射（用于覆盖提示）
  const navMapQuery = useNavTotalAssetMap(portfolioId);
  const navMap = navMapQuery.data;
  const dateValue = watch('date');
  const systemValue = useMemo(
    () => (dateValue && navMap ? navMap.get(dateValue) ?? null : null),
    [dateValue, navMap],
  );

  const onSubmit = (values: SnapshotFormValues) => {
    setSubmitting(true);
    const payload = {
      date: values.date,
      totalAsset: values.totalAsset,
      marketValue: values.marketValue || undefined,
      cashBalance: values.cashBalance || undefined,
      note: values.note || undefined,
    };
    const onSettled = () => setSubmitting(false);
    const onOk = () => {
      reset({
        date: today,
        totalAsset: '',
        marketValue: '',
        cashBalance: '',
        note: '',
      });
      onSuccess?.();
    };

    if (isManualEdit && snapshot) {
      updateMutation.mutate(
        { portfolioId, id: snapshot.id, payload },
        { onSettled, onSuccess: onOk },
      );
    } else {
      // 新建 或 编辑 DERIVED 行 → POST upsert（保存后变手工）
      upsertMutation.mutate(
        { portfolioId, payload },
        { onSettled, onSuccess: onOk },
      );
    }
  };

  const isPending = upsertMutation.isPending || updateMutation.isPending;

  return (
    <form onSubmit={handleSubmit(onSubmit)} className={className}>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="snapshot-date">日期</Label>
          <Input
            id="snapshot-date"
            type="date"
            max={today}
            {...register('date')}
          />
          {errors.date && (
            <p className="text-xs text-red-500">{errors.date.message}</p>
          )}
        </div>

        {/* 覆盖提示 */}
        {systemValue !== null && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              该日系统自动计算值为 ¥
              {formatCurrency(systemValue)}，保存后将取代为手工记录。
            </span>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="snapshot-asset">当日总资产（元）*</Label>
          <Input
            id="snapshot-asset"
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            {...register('totalAsset')}
          />
          {errors.totalAsset && (
            <p className="text-xs text-red-500">{errors.totalAsset.message}</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="snapshot-market">持仓市值（元）</Label>
            <Input
              id="snapshot-market"
              type="number"
              step="0.01"
              min="0"
              placeholder="可选"
              {...register('marketValue')}
            />
            {errors.marketValue && (
              <p className="text-xs text-red-500">
                {errors.marketValue.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="snapshot-cash">现金余额（元）</Label>
            <Input
              id="snapshot-cash"
              type="number"
              step="0.01"
              min="0"
              placeholder="可选"
              {...register('cashBalance')}
            />
            {errors.cashBalance && (
              <p className="text-xs text-red-500">
                {errors.cashBalance.message}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="snapshot-note">备注（可选）</Label>
          <Textarea
            id="snapshot-note"
            placeholder="如：月末估值 / 季度盘点"
            rows={2}
            {...register('note')}
          />
          {errors.note && (
            <p className="text-xs text-red-500">{errors.note.message}</p>
          )}
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button type="submit" disabled={isPending}>
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isManualEdit ? '保存' : '录入'}
        </Button>
      </div>
    </form>
  );
}
