/**
 * features/auth/login-form.tsx — 登录表单
 *
 * React Hook Form + Zod 校验，提交后写入 auth store + 跳转。
 *
 * 扩展（SYS-P1-02 · PRD §7.10）：当登录接口返回业务码 1007（账户处于注销冷静期）
 * 时，不再停留在普通登录失败态，而是切换到「恢复引导卡片」，允许用户凭已输入的
 * 邮箱 + 密码一键恢复账户。其他错误（1001 邮箱/密码错、网络异常等）仍按原逻辑，
 * 由 api-client 拦截器统一 toast 提示。
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useLogin } from '@/hooks/use-auth';
import { useRestoreAccount } from '@/hooks/use-account';
import { ROUTE_PATH } from '@/lib/constants';
import { ApiError } from '@/lib/api-client';
import {
  BUSINESS_ERROR_CODE,
  ACCOUNT_RETENTION_DAYS,
  type AccountPendingDeletionData,
} from '@/lib/types';
import { AccountRestorePrompt } from './account-restore-prompt';

const loginSchema = z.object({
  email: z.string().email('请输入有效的邮箱'),
  password: z.string().min(6, '密码至少 6 位'),
});

type LoginFormValues = z.infer<typeof loginSchema>;

/** 注销冷静期子状态：捕获到 1007 时进入，并暂存用户已输入的凭证用于恢复 */
interface PendingDeletionState {
  email: string;
  password: string;
  remainingDays: number;
}

export function LoginForm(): JSX.Element {
  const loginMutation = useLogin();
  const restoreMutation = useRestoreAccount();
  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletionState | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = (values: LoginFormValues) => {
    // 每次重新提交都先清空可能存在的冷静期子状态
    setPendingDeletion(null);
    loginMutation.mutate(values, {
      // 仅拦截 1007：把它从「登录失败」升级为「恢复引导」，其余错误不动
      onError: (error) => {
        if (error instanceof ApiError && error.code === BUSINESS_ERROR_CODE.PENDING_DELETION) {
          const data = (error.data ?? null) as AccountPendingDeletionData | null;
          setPendingDeletion({
            email: values.email,
            password: values.password,
            remainingDays: data?.remainingDays ?? ACCOUNT_RETENTION_DAYS,
          });
        }
      },
    });
  };

  const handleRestore = () => {
    if (!pendingDeletion) {
      return;
    }
    restoreMutation.mutate({
      email: pendingDeletion.email,
      password: pendingDeletion.password,
    });
  };

  const handleDismiss = () => {
    setPendingDeletion(null);
  };

  // 注销冷静期：渲染恢复引导卡片，而非普通登录表单
  if (pendingDeletion) {
    return (
      <AccountRestorePrompt
        remainingDays={pendingDeletion.remainingDays}
        isRestoring={restoreMutation.isPending}
        onRestore={handleRestore}
        onDismiss={handleDismiss}
      />
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-2xl">登录</CardTitle>
        <CardDescription>输入您的邮箱与密码登录系统</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit(onSubmit)}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">邮箱</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              {...register('email')}
            />
            {errors.email && (
              <p className="text-xs text-red-500">{errors.email.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              {...register('password')}
            />
            {errors.password && (
              <p className="text-xs text-red-500">{errors.password.message}</p>
            )}
          </div>
        </CardContent>
        <CardFooter className="flex flex-col space-y-3">
          <Button
            type="submit"
            className="w-full"
            disabled={loginMutation.isPending}
          >
            {loginMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            登录
          </Button>
          <p className="text-sm text-muted-foreground">
            还没有账号？{' '}
            <Link
              to={ROUTE_PATH.REGISTER}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              立即注册
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
