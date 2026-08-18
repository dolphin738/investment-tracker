<script setup lang="ts">
/**
 * modules/account/components/ChangePasswordDialog.vue — 修改密码对话框
 *
 * 自 React 版 web/src/features/account/change-password-dialog.tsx 平移。
 * 受控组件：通过 open / open-change 事件控制显隐。
 *
 * 注意：后端 ValidationPipe 开启了 forbidNonWhitelisted，
 * confirmPassword 只做前端一致性校验，提交时必须剔除，否则请求会被 400 拒绝。
 * 密码强度规则需与后端 dto/password-policy.ts 保持一致。
 */
import { computed, watch } from 'vue';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { Check, Loader2, X } from 'lucide-vue-next';
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
import { zodToTypedSchema } from '@/lib/zod-typed-schema';
import { useUpdatePassword } from '../composables/use-account';

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

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  openChange: [open: boolean];
}>();

const updateMutation = useUpdatePassword();

const {
  handleSubmit,
  resetForm,
  defineField,
  errors,
} = useForm<ChangePasswordFormValues>({
  validationSchema: zodToTypedSchema(changePasswordSchema),
  initialValues: {
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  },
});

const [currentPassword, currentPasswordAttrs] = defineField('currentPassword', {
  validateOnModelUpdate: false,
});
const [newPassword, newPasswordAttrs] = defineField('newPassword', {
  validateOnModelUpdate: false,
});
const [confirmPassword, confirmPasswordAttrs] = defineField('confirmPassword', {
  validateOnModelUpdate: false,
});

// 打开时清空表单
watch(
  () => props.open,
  (open) => {
    if (open) {
      resetForm({
        values: { currentPassword: '', newPassword: '', confirmPassword: '' },
      });
    }
  },
);

/** 密码强度检查项 */
const rules = computed(() => [
  { label: '至少 8 位', passed: (newPassword.value ?? '').length >= 8 },
  { label: '包含字母', passed: /[A-Za-z]/.test(newPassword.value ?? '') },
  { label: '包含数字', passed: /\d/.test(newPassword.value ?? '') },
]);

const onSubmit = handleSubmit((values) => {
  // 只提交后端 DTO 声明过的字段，confirmPassword 绝不外发
  updateMutation.mutate(
    {
      currentPassword: values.currentPassword,
      newPassword: values.newPassword,
    },
    { onSuccess: () => emit('openChange', false) },
  );
});

const isPending = computed(() => updateMutation.isPending.value);
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => emit('openChange', v)">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>修改密码</DialogTitle>
        <DialogDescription>
          修改成功后当前登录状态会自动续期，无需重新登录
        </DialogDescription>
      </DialogHeader>
      <form @submit="onSubmit">
        <div class="space-y-4">
          <div class="space-y-2">
            <Label for="pwd-current">当前密码</Label>
            <Input
              id="pwd-current"
              type="password"
              autocomplete="current-password"
              v-model="currentPassword"
              v-bind="currentPasswordAttrs"
            />
            <p v-if="errors.currentPassword" class="text-xs text-destructive">
              {{ errors.currentPassword }}
            </p>
          </div>
          <div class="space-y-2">
            <Label for="pwd-new">新密码</Label>
            <Input
              id="pwd-new"
              type="password"
              autocomplete="new-password"
              v-model="newPassword"
              v-bind="newPasswordAttrs"
            />
            <ul class="flex flex-wrap gap-x-4 gap-y-1">
              <li
                v-for="rule in rules"
                :key="rule.label"
                :class="cn(
                  'flex items-center gap-1 text-xs',
                  rule.passed ? 'text-green-600' : 'text-muted-foreground',
                )"
              >
                <Check v-if="rule.passed" class="h-3 w-3" />
                <X v-else class="h-3 w-3" />
                {{ rule.label }}
              </li>
            </ul>
            <p v-if="errors.newPassword" class="text-xs text-destructive">
              {{ errors.newPassword }}
            </p>
          </div>
          <div class="space-y-2">
            <Label for="pwd-confirm">确认新密码</Label>
            <Input
              id="pwd-confirm"
              type="password"
              autocomplete="new-password"
              v-model="confirmPassword"
              v-bind="confirmPasswordAttrs"
            />
            <p v-if="errors.confirmPassword" class="text-xs text-destructive">
              {{ errors.confirmPassword }}
            </p>
          </div>
        </div>
        <DialogFooter class="mt-6">
          <Button
            type="button"
            variant="outline"
            :disabled="isPending"
            @click="emit('openChange', false)"
          >
            取消
          </Button>
          <Button type="submit" :disabled="isPending">
            <Loader2 v-if="isPending" class="mr-2 h-4 w-4 animate-spin" />
            保存
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>