/**
 * features/auth/register-form.tsx — 注册表单
 */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useRegister } from '@/hooks/use-auth';
import { ROUTE_PATH } from '@/lib/constants';

const registerSchema = z
  .object({
    email: z.string().email('请输入有效的邮箱'),
    name: z.string().max(50, '名称最多 50 字').optional(),
    password: z
      .string()
      .min(8, '密码至少 8 位')
      .regex(/^(?=.*[A-Za-z])(?=.*\d)/, '密码需同时包含字母和数字'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: '两次输入的密码不一致',
    path: ['confirmPassword'],
  });

type RegisterFormValues = z.infer<typeof registerSchema>;

export function RegisterForm(): JSX.Element {
  const registerMutation = useRegister();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: '', name: '', password: '', confirmPassword: '' },
  });

  const onSubmit = (values: RegisterFormValues) => {
    registerMutation.mutate({
      email: values.email,
      password: values.password,
      name: values.name || undefined,
    });
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-2xl">注册</CardTitle>
        <CardDescription>创建您的投资追踪账号</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit(onSubmit)}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">邮箱</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              {...register('email')}
            />
            {errors.email && (
              <p className="text-xs text-red-500">{errors.email.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="name">名称（可选）</Label>
            <Input id="name" type="text" {...register('name')} />
            {errors.name && (
              <p className="text-xs text-red-500">{errors.name.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input id="password" type="password" {...register('password')} />
            {errors.password && (
              <p className="text-xs text-red-500">{errors.password.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirmPassword">确认密码</Label>
            <Input
              id="confirmPassword"
              type="password"
              {...register('confirmPassword')}
            />
            {errors.confirmPassword && (
              <p className="text-xs text-red-500">
                {errors.confirmPassword.message}
              </p>
            )}
          </div>
        </CardContent>
        <CardFooter className="flex flex-col space-y-3">
          <Button
            type="submit"
            className="w-full"
            disabled={registerMutation.isPending}
          >
            {registerMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            注册
          </Button>
          <p className="text-sm text-muted-foreground">
            已有账号？{' '}
            <Link
              to={ROUTE_PATH.LOGIN}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              返回登录
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
