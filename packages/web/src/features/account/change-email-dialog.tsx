/**
 * features/account/change-email-dialog.tsx — 修改邮箱对话框
 *
 * 受控组件：通过 open / onOpenChange 控制显隐。
 * 修改邮箱属敏感操作，必须输入当前密码二次校验。
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
import { useUpdateEmail } from '@/hooks/use-account';
import { useAuthStore } from '@/stores/auth.store';

const changeEmailSchema = z.object({
  newEmail: z.string().min(1, '请输入新邮箱').email('请输入有效的邮箱'),
  currentPassword: z.string().min(1, '请输入当前密码'),
});

type ChangeEmailFormValues = z.infer<typeof changeEmailSchema>;

export interface ChangeEmailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangeEmailDialog({
  open,
  onOpenChange,
}: ChangeEmailDialogProps): JSX.Element {
  const user = useAuthStore((s) => s.user);
  const updateMutation = useUpdateEmail();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<ChangeEmailFormValues>({
    resolver: zodResolver(changeEmailSchema),
    defaultValues: { newEmail: '', currentPassword: '' },
  });

  useEffect(() => {
    if (open) {
      reset({ newEmail: '', currentPassword: '' });
    }
  }, [open, reset]);

  const onSubmit = (values: ChangeEmailFormValues) => {
    // 前端先拦一道「与当前邮箱相同」，避免无谓请求
    if (user?.email && values.newEmail === user.email) {
      setError('newEmail', { message: '新邮箱与当前邮箱相同' });
      return;
    }
    updateMutation.mutate(
      {
        currentPassword: values.currentPassword,
        newEmail: values.newEmail,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  const isPending = updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>修改邮箱</DialogTitle>
          <DialogDescription>
            邮箱是登录凭证，修改后请使用新邮箱登录
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)}>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="current-email">当前邮箱</Label>
              <Input id="current-email" disabled value={user?.email ?? ''} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-email">新邮箱</Label>
              <Input
                id="new-email"
                type="email"
                autoComplete="email"
                placeholder="new@example.com"
                {...register('newEmail')}
              />
              {errors.newEmail && (
                <p className="text-xs text-red-500">{errors.newEmail.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="email-current-password">当前密码</Label>
              <Input
                id="email-current-password"
                type="password"
                autoComplete="current-password"
                {...register('currentPassword')}
              />
              {errors.currentPassword && (
                <p className="text-xs text-red-500">
                  {errors.currentPassword.message}
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
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
