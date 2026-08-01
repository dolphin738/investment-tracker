/**
 * features/account/change-password-dialog.tsx — 修改密码对话框
 *
 * 受控组件：通过 open / onOpenChange 控制显隐。
 *
 * 注意：后端 ValidationPipe 开启了 forbidNonWhitelisted，
 * confirmPassword 只做前端一致性校验，提交时必须剔除，否则请求会被 400 拒绝。
 * 密码强度规则需与后端 dto/password-policy.ts 保持一致。
 */

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Check, Loader2, X } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import { useUpdatePassword } from '@/hooks/use-account';

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, '请输入当前密码'),
    newPassword: z
      .string()
      .min(8, '密码至少 8 位')
      .max(100, '密码最多 100 位')
      .regex(/^(?=.*[A-Za-z])(?=.*\d)/, '密码需同时包含字母和数字'),
    confirmPassword: z.string().min(1, '请再次输入新密码'),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: '两次输入的密码不一致',
  });

type ChangePasswordFormValues = z.infer<typeof changePasswordSchema>;

/** 密码强度检查项 */
interface StrengthRule {
  label: string;
  passed: boolean;
}

export interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangePasswordDialog({
  open,
  onOpenChange,
}: ChangePasswordDialogProps): JSX.Element {
  const updateMutation = useUpdatePassword();
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  useEffect(() => {
    if (open) {
      reset({ currentPassword: '', newPassword: '', confirmPassword: '' });
    }
  }, [open, reset]);

  const newPassword = watch('newPassword') ?? '';
  const rules: StrengthRule[] = [
    { label: '至少 8 位', passed: newPassword.length >= 8 },
    { label: '包含字母', passed: /[A-Za-z]/.test(newPassword) },
    { label: '包含数字', passed: /\d/.test(newPassword) },
  ];

  const onSubmit = (values: ChangePasswordFormValues) => {
    // 只提交后端 DTO 声明过的字段，confirmPassword 绝不外发
    updateMutation.mutate(
      {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  const isPending = updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>修改密码</DialogTitle>
          <DialogDescription>
            修改成功后当前登录状态会自动续期，无需重新登录
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)}>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pwd-current">当前密码</Label>
              <Input
                id="pwd-current"
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
            <div className="space-y-2">
              <Label htmlFor="pwd-new">新密码</Label>
              <Input
                id="pwd-new"
                type="password"
                autoComplete="new-password"
                {...register('newPassword')}
              />
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {rules.map((rule) => (
                  <li
                    key={rule.label}
                    className={cn(
                      'flex items-center gap-1 text-xs',
                      rule.passed ? 'text-green-600' : 'text-muted-foreground',
                    )}
                  >
                    {rule.passed ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <X className="h-3 w-3" />
                    )}
                    {rule.label}
                  </li>
                ))}
              </ul>
              {errors.newPassword && (
                <p className="text-xs text-red-500">
                  {errors.newPassword.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="pwd-confirm">确认新密码</Label>
              <Input
                id="pwd-confirm"
                type="password"
                autoComplete="new-password"
                {...register('confirmPassword')}
              />
              {errors.confirmPassword && (
                <p className="text-xs text-red-500">
                  {errors.confirmPassword.message}
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
