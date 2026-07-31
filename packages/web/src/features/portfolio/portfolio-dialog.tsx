/**
 * features/portfolio/portfolio-dialog.tsx — 创建/编辑组合对话框
 *
 * 受控组件：通过 open / onOpenChange 控制显隐。
 */

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  useCreatePortfolio,
  useUpdatePortfolio,
} from '@/hooks/use-portfolios';
import type { Portfolio } from '@investment-tracker/shared';

const portfolioSchema = z.object({
  name: z.string().min(1, '请输入组合名称').max(50, '名称最多 50 字'),
  description: z.string().max(200, '描述最多 200 字').optional(),
});

type PortfolioFormValues = z.infer<typeof portfolioSchema>;

export interface PortfolioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 传入则编辑模式，否则创建 */
  portfolio?: Portfolio | null;
}

export function PortfolioDialog({
  open,
  onOpenChange,
  portfolio,
}: PortfolioDialogProps): JSX.Element {
  const isEdit = Boolean(portfolio);
  const createMutation = useCreatePortfolio();
  const updateMutation = useUpdatePortfolio();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PortfolioFormValues>({
    resolver: zodResolver(portfolioSchema),
    defaultValues: { name: '', description: '' },
  });

  useEffect(() => {
    if (open) {
      reset({
        name: portfolio?.name ?? '',
        description: portfolio?.description ?? '',
      });
    }
  }, [open, portfolio, reset]);

  const onSubmit = (values: PortfolioFormValues) => {
    if (isEdit && portfolio) {
      updateMutation.mutate(
        { id: portfolio.id, payload: values },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      createMutation.mutate(values, {
        onSuccess: () => onOpenChange(false),
      });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑组合' : '新建组合'}</DialogTitle>
          <DialogDescription>
            {isEdit ? '修改组合的名称或描述' : '创建一个新的投资组合'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)}>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="portfolio-name">名称</Label>
              <Input
                id="portfolio-name"
                placeholder="如：A股长线组合"
                {...register('name')}
              />
              {errors.name && (
                <p className="text-xs text-red-500">{errors.name.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="portfolio-description">描述（可选）</Label>
              <Textarea
                id="portfolio-description"
                placeholder="组合策略、目标等"
                rows={3}
                {...register('description')}
              />
              {errors.description && (
                <p className="text-xs text-red-500">
                  {errors.description.message}
                </p>
              )}
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              取消
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isEdit ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
