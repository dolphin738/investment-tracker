<script setup lang="ts">
/**
 * modules/account/components/ChangeEmailDialog.vue — 修改邮箱对话框
 *
 * 自 React 版 web/src/features/account/change-email-dialog.tsx 平移。
 * 受控组件：通过 open / open-change 事件控制显隐。
 * 修改邮箱属敏感操作，必须输入当前密码二次校验。
 */
import { computed, watch } from 'vue';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { Loader2 } from 'lucide-vue-next';
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
import { zodToTypedSchema } from '@/lib/zod-typed-schema';
import { useAuthStore } from '@/stores/auth.store';
import { useUpdateEmail } from '../composables/use-account';

const changeEmailSchema = z.object({
  newEmail: z.string().min(1, '请输入新邮箱').email('请输入有效的邮箱'),
  currentPassword: z.string().min(1, '请输入当前密码'),
});

type ChangeEmailFormValues = z.infer<typeof changeEmailSchema>;

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  openChange: [open: boolean];
}>();

const authStore = useAuthStore();
const user = authStore.user;
const updateMutation = useUpdateEmail();

const {
  handleSubmit,
  resetForm,
  defineField,
  errors,
  setFieldError,
} = useForm<ChangeEmailFormValues>({
  validationSchema: zodToTypedSchema(changeEmailSchema),
  initialValues: { newEmail: '', currentPassword: '' },
});

const [newEmail, newEmailAttrs] = defineField('newEmail', {
  validateOnModelUpdate: false,
});
const [currentPassword, currentPasswordAttrs] = defineField('currentPassword', {
  validateOnModelUpdate: false,
});

// 打开时清空表单（对齐 React 版 useEffect 的 reset）
watch(
  () => props.open,
  (open) => {
    if (open) {
      resetForm({ values: { newEmail: '', currentPassword: '' } });
    }
  },
);

const onSubmit = handleSubmit((values) => {
  // 前端先拦一道「与当前邮箱相同」，避免无谓请求
  if (user?.email && values.newEmail === user.email) {
    setFieldError('newEmail', '新邮箱与当前邮箱相同');
    return;
  }
  updateMutation.mutate(
    {
      currentPassword: values.currentPassword,
      newEmail: values.newEmail,
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
        <DialogTitle>修改邮箱</DialogTitle>
        <DialogDescription>
          邮箱是登录凭证，修改后请使用新邮箱登录
        </DialogDescription>
      </DialogHeader>
      <form @submit="onSubmit">
        <div class="space-y-4">
          <div class="space-y-2">
            <Label for="current-email">当前邮箱</Label>
            <Input id="current-email" disabled :model-value="user?.email ?? ''" />
          </div>
          <div class="space-y-2">
            <Label for="new-email">新邮箱</Label>
            <Input
              id="new-email"
              type="email"
              autocomplete="email"
              placeholder="new@example.com"
              v-model="newEmail"
              v-bind="newEmailAttrs"
            />
            <p v-if="errors.newEmail" class="text-xs text-destructive">
              {{ errors.newEmail }}
            </p>
          </div>
          <div class="space-y-2">
            <Label for="email-current-password">当前密码</Label>
            <Input
              id="email-current-password"
              type="password"
              autocomplete="current-password"
              v-model="currentPassword"
              v-bind="currentPasswordAttrs"
            />
            <p v-if="errors.currentPassword" class="text-xs text-destructive">
              {{ errors.currentPassword }}
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