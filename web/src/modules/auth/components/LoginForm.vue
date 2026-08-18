<script setup lang="ts">
/**
 * modules/auth/components/LoginForm.vue — 登录表单
 *
 * 自 React 版 web/src/features/auth/login-form.tsx 平移。
 * vee-validate + Zod 校验（zod schema 原样平移，校验消息逐字一致），
 * 提交后写入 auth store + 跳转。
 *
 * 扩展（SYS-P1-02 · PRD §7.10）：当登录接口返回业务码 1007（账户处于注销冷静期）
 * 时，不再停留在普通登录失败态，而是切换到「恢复引导卡片」，允许用户凭已输入的
 * 邮箱 + 密码一键恢复账户。其他错误（1001 邮箱/密码错、网络异常等）仍按原逻辑，
 * 由 api-client 拦截器统一 toast 提示。
 *
 * 校验时机：与 React Hook Form 默认 onSubmit 模式对齐——仅在提交时校验
 * （defineField 关闭 model 更新时的即时校验），提交后修正字段再次提交时刷新错误。
 */

import { computed, ref } from 'vue';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { Loader2 } from 'lucide-vue-next';
import { RouterLink } from 'vue-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useLogin } from '../composables/use-auth';
import { useRestoreAccount } from '../composables/use-account';
import { ROUTE_PATH } from '@/lib/constants';
import { ApiError } from '@/lib/api-client';
import {
  BUSINESS_ERROR_CODE,
  ACCOUNT_RETENTION_DAYS,
  type AccountPendingDeletionData,
} from '@/lib/types';
import { zodToTypedSchema } from '../composables/zod-validation';
import AccountRestorePrompt from './AccountRestorePrompt.vue';

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

const loginMutation = useLogin();
const restoreMutation = useRestoreAccount();
const pendingDeletion = ref<PendingDeletionState | null>(null);

const { handleSubmit, defineField, errors } = useForm<LoginFormValues>({
  validationSchema: zodToTypedSchema(loginSchema),
  initialValues: { email: '', password: '' },
});

const [email, emailAttrs] = defineField('email', { validateOnModelUpdate: false });
const [password, passwordAttrs] = defineField('password', { validateOnModelUpdate: false });

const isLoginPending = computed(() => loginMutation.isPending.value);
const isRestoring = computed(() => restoreMutation.isPending.value);

const onSubmit = handleSubmit((values) => {
  // 每次重新提交都先清空可能存在的冷静期子状态
  pendingDeletion.value = null;
  loginMutation.mutate(values, {
    // 仅拦截 1007：把它从「登录失败」升级为「恢复引导」，其余错误不动
    onError: (error) => {
      if (error instanceof ApiError && error.code === BUSINESS_ERROR_CODE.PENDING_DELETION) {
        const data = (error.data ?? null) as AccountPendingDeletionData | null;
        pendingDeletion.value = {
          email: values.email,
          password: values.password,
          remainingDays: data?.remainingDays ?? ACCOUNT_RETENTION_DAYS,
        };
      }
    },
  });
});

function handleRestore(): void {
  if (!pendingDeletion.value) {
    return;
  }
  restoreMutation.mutate({
    email: pendingDeletion.value.email,
    password: pendingDeletion.value.password,
  });
}

function handleDismiss(): void {
  pendingDeletion.value = null;
}
</script>

<template>
  <!-- 注销冷静期：渲染恢复引导卡片，而非普通登录表单 -->
  <AccountRestorePrompt
    v-if="pendingDeletion"
    :remaining-days="pendingDeletion.remainingDays"
    :is-restoring="isRestoring"
    @restore="handleRestore"
    @dismiss="handleDismiss"
  />
  <Card v-else class="w-full max-w-md">
    <CardHeader>
      <CardTitle class="text-2xl">登录</CardTitle>
      <CardDescription>输入您的邮箱与密码登录系统</CardDescription>
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
            autocomplete="email"
          />
          <p v-if="errors.email" class="text-xs text-destructive">
            {{ errors.email }}
          </p>
        </div>
        <div class="space-y-2">
          <Label for="password">密码</Label>
          <Input
            id="password"
            v-model="password"
            v-bind="passwordAttrs"
            type="password"
            autocomplete="current-password"
          />
          <p v-if="errors.password" class="text-xs text-destructive">
            {{ errors.password }}
          </p>
        </div>
      </CardContent>
      <CardFooter class="flex flex-col space-y-3">
        <Button
          type="submit"
          class="w-full"
          :disabled="isLoginPending"
        >
          <Loader2 v-if="isLoginPending" class="mr-2 h-4 w-4 animate-spin" />
          登录
        </Button>
        <p class="text-sm text-muted-foreground">
          还没有账号？
          <RouterLink
            :to="ROUTE_PATH.REGISTER"
            class="font-medium text-primary underline-offset-4 hover:underline"
          >
            立即注册
          </RouterLink>
        </p>
      </CardFooter>
    </form>
  </Card>
</template>
