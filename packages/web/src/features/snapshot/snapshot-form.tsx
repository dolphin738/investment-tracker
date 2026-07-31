/**
 * features/snapshot/snapshot-form.tsx — 资产快照录入表单
 *
 * upsert 语义：每日唯一。如果当日已有快照，提示覆盖确认。
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useUpsertSnapshot } from '@/hooks/use-snapshots';
import { useSnapshots } from '@/hooks/use-snapshots';
import { toIsoDate } from '@/lib/constants';

const snapshotSchema = z.object({
  date: z
    .string()
    .min(1, '请选择日期')
    .refine((v) => {
      const today = toIsoDate(new Date());
      return v <= today;
    }, '日期不能为未来'),
  totalAsset: z
    .string()
    .min(1, '请输入资产总额')
    .refine((v) => Number(v) > 0, '金额必须大于 0'),
  note: z.string().max(200, '备注最多 200 字').optional(),
});

type SnapshotFormValues = z.infer<typeof snapshotSchema>;

export interface SnapshotFormProps {
  portfolioId: string;
  onSuccess?: () => void;
  className?: string;
}

export function SnapshotForm({
  portfolioId,
  onSuccess,
  className,
}: SnapshotFormProps): JSX.Element {
  const today = toIsoDate(new Date());
  const upsertMutation = useUpsertSnapshot();
  const [pendingValues, setPendingValues] = useState<SnapshotFormValues | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<SnapshotFormValues>({
    resolver: zodResolver(snapshotSchema),
    defaultValues: { date: today, totalAsset: '', note: '' },
  });

  // 检查当日是否已有快照（用于覆盖确认）
  const dateValue = watch('date');
  const { data: existingList } = useSnapshots(portfolioId, {
    startDate: dateValue,
    endDate: dateValue,
    page: 1,
    pageSize: 1,
  });

  const submit = (values: SnapshotFormValues) => {
    upsertMutation.mutate(
      {
        portfolioId,
        payload: {
          date: values.date,
          totalAsset: values.totalAsset,
          note: values.note || undefined,
        },
      },
      {
        onSuccess: () => {
          reset({ date: today, totalAsset: '', note: '' });
          onSuccess?.();
        },
      },
    );
  };

  const onSubmit = (values: SnapshotFormValues) => {
    // 若当日已有快照，弹窗确认覆盖
    const hasExisting = existingList && existingList.items.length > 0;
    if (hasExisting) {
      setPendingValues(values);
      return;
    }
    submit(values);
  };

  const handleConfirmOverwrite = () => {
    if (pendingValues) {
      submit(pendingValues);
      setPendingValues(null);
    }
  };

  useEffect(() => {
    if (!upsertMutation.isPending) {
      // no-op，仅用于触发重渲染
    }
  }, [upsertMutation.isPending]);

  return (
    <>
      <form onSubmit={handleSubmit(onSubmit)} className={className}>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="snapshot-date">日期</Label>
            <Input id="snapshot-date" type="date" max={today} {...register('date')} />
            {errors.date && (
              <p className="text-xs text-red-500">{errors.date.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="snapshot-asset">当日资产总额（元）</Label>
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

        <div className="mt-6 flex justify-end">
          <Button type="submit" disabled={upsertMutation.isPending}>
            {upsertMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            保存
          </Button>
        </div>
      </form>

      {/* 覆盖确认对话框 */}
      <AlertDialog
        open={Boolean(pendingValues)}
        onOpenChange={(o) => !o && setPendingValues(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>当日已存在快照，是否覆盖？</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingValues && pendingValues.date} 已有资产快照记录，
              继续将覆盖原数据并触发当日净值与 XIRR 重算。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmOverwrite}
              disabled={upsertMutation.isPending}
            >
              {upsertMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              确认覆盖
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
