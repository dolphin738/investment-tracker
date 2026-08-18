<script setup lang="ts">
/**
 * modules/auth/components/RegisterForm.vue — 注册表单
 *
 * 自 React 版 web/src/features/auth/register-form.tsx 平移。
 * vee-validate + Zod 校验（zod schema 原样平移，校验消息逐字一致），
 * 提交成功跳登录页，失败由 api-client 拦截器统一 toast。
 *
 * 校验时机：与 React Hook Form 默认 onSubmit 模式对齐——仅在提交时校验。
 */

import { computed } from 'vue';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { Loader2 } from 'lucide-vue-next';
import { RouterLink } from 'vue-router';
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
import { useRegister } from '../composables/use-auth';
import { ROUTE_PATH } from '@/lib/constants';
import { zodToTypedSchema } from '../composables/zod-validation';

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

const registerMutation = useRegister();

const { handleSubmit, defineField, errors } = useForm<RegisterFormValues>({
  validationSchema: zodToTypedSchema(registerSchema),
  initialValues: { email: '', name: '', password: '', confirmPassword: '' },
});

const [email, emailAttrs] = defineField('email', { validateOnModelUpdate: false });
const [name, nameAttrs] = defineField('name', { validateOnModelUpdate: false });
const [password, passwordAttrs] = defineField('password', { validateOnModelUpdate: false });
const [confirmPassword, confirmPasswordAttrs] = defineField('confirmPassword', {
  validateOnModelUpdate: false,
});

const isRegisterPending = computed(() => registerMutation.isPending.value);

const onSubmit = handleSubmit((values) => {
  registerMutation.mutate({
    email: values.email,
    password: values.password,
    name: values.name || undefined,
  });
});
</script>

<template>
  <Card class="w-full max-w-md">
    <CardHeader>
      <CardTitle class="text-2xl">注册</CardTitle>
      <CardDescription>创建您的投资追踪账号</CardDescription>
    </CardHeader>
    <form @submit="onSubmit">
      <CardContent class="space-y-4">
        <div class="space-y-2">
          <Label for="email">邮箱</Label>
          <Input
            id="email"
            v-model="email"
            v-bind="emailAttrs"
            type="email"
            placeholder="you@example.com"
          />
          <p v-if="errors.email" class="text-xs text-destructive">
            {{ errors.email }}
          </p>
        </div>
        <div class="space-y-2">
          <Label for="name">名称（可选）</Label>
          <Input id="name" v-model="name" v-bind="nameAttrs" type="text" />
          <p v-if="errors.name" class="text-xs text-destructive">
            {{ errors.name }}
          </p>
        </div>
        <div class="space-y-2">
          <Label for="password">密码</Label>
          <Input id="password" v-model="password" v-bind="passwordAttrs" type="password" />
          <p v-if="errors.password" class="text-xs text-destructive">
            {{ errors.password }}
          </p>
        </div>
        <div class="space-y-2">
          <Label for="confirmPassword">确认密码</Label>
          <Input
            id="confirmPassword"
            v-model="confirmPassword"
            v-bind="confirmPasswordAttrs"
            type="password"
          />
          <p v-if="errors.confirmPassword" class="text-xs text-destructive">
            {{ errors.confirmPassword }}
          </p>
        </div>
      </CardContent>
      <CardFooter class="flex flex-col space-y-3">
        <Button
          type="submit"
          class="w-full"
          :disabled="isRegisterPending"
        >
          <Loader2 v-if="isRegisterPending" class="mr-2 h-4 w-4 animate-spin" />
          注册
        </Button>
        <p class="text-sm text-muted-foreground">
          已有账号？
          <RouterLink
            :to="ROUTE_PATH.LOGIN"
            class="font-medium text-primary underline-offset-4 hover:underline"
          >
            返回登录
          </RouterLink>
        </p>
      </CardFooter>
    </form>
  </Card>
</template>
