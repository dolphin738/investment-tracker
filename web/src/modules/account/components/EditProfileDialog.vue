<script setup lang="ts">
/**
 * modules/account/components/EditProfileDialog.vue — 编辑个人资料对话框
 *
 * 自 React 版 web/src/features/account/edit-profile-dialog.tsx 平移。
 * 受控组件：通过 open / open-change 事件控制显隐。
 *
 * 头像（AC-11）：支持两种设置方式，二者均在编辑资料卡片内完成：
 *   1）本地上传 —— 点击头像唤起文件选择 → 前端预校验（类型 + 大小）→ 上传 → 后端落盘写库后回写预览；
 *   2）头像 URL —— 在下方输入框填入图片地址，随「保存」一起提交生效。
 * 两种方式并列，最后生效者覆盖前者；「移除头像」可清空为默认头像。
 *
 * 清空语义：未填字段统一归一为空串 '' 再提交，后端把 '' 转成 NULL，
 * 这样「把昵称删掉后保存」才能真正清空，而不是被当作「不修改」。
 */
import { computed, ref, watch } from 'vue';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { Camera, Loader2, X } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { toast } from '@/composables/use-toast';
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
import { zodToTypedSchema } from '@/lib/zod-typed-schema';
import UserAvatar from '@/components/common/UserAvatar.vue';
import { useAuthStore } from '@/stores/auth.store';
import { useUpdateProfile, useUploadAvatar } from '../composables/use-account';

/** 允许上传的图片 MIME（与后端 upload.constants.ts 的 ALLOWED_MIME 保持一致） */
const ACCEPTED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** 单文件大小上限 2MB（与后端 MAX_SIZE 保持一致） */
const MAX_AVATAR_SIZE = 2 * 1024 * 1024;

/** <input accept> 属性值 */
const ACCEPT_ATTR = ACCEPTED_IMAGE_MIME.join(',');

/** 与后端 update-profile.dto.ts 保持一致的校验规则（空串代表清空，需放行） */
const editProfileSchema = z.object({
  // 头像由上传流程写入，可能是站内相对路径（/api/uploads/...）或历史 http(s) 外链，
  // 与后端放宽后的 AVATAR_PATTERN 对齐，不再强制要求协议头。
  avatar: z
    .string()
    .max(512, '头像地址最多 512 字符')
    // /^\/(?!\/)/ 与后端一致地排除 `//evil.com` 这类协议相对 URL
    .refine((v) => v === '' || /^\/(?!\/)/.test(v) || /^https?:\/\//.test(v), {
      message: '头像地址格式不正确',
    }),
  name: z.string().max(100, '昵称最多 100 字'),
  phone: z
    .string()
    .refine((v) => v === '' || /^1[3-9]\d{9}$/.test(v), {
      message: '请输入正确的手机号',
    }),
  bio: z.string().max(200, '简介最多 200 字'),
});

type EditProfileFormValues = z.infer<typeof editProfileSchema>;

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  openChange: [open: boolean];
}>();

const authStore = useAuthStore();
const user = authStore.user;
const userEmail = computed(() => user?.email ?? '');
const nameFieldName = computed(() => user?.name ?? null);
const updateMutation = useUpdateProfile();
const uploadMutation = useUploadAvatar();
const fileInputRef = ref<HTMLInputElement | null>(null);

const {
  handleSubmit,
  resetForm,
  defineField,
  errors,
  setFieldValue,
  meta,
} = useForm<EditProfileFormValues>({
  validationSchema: zodToTypedSchema(editProfileSchema),
  initialValues: { avatar: '', name: '', phone: '', bio: '' },
});

const [avatar, avatarAttrs] = defineField('avatar', {
  validateOnModelUpdate: false,
});
const [name, nameAttrs] = defineField('name', { validateOnModelUpdate: false });
const [phone, phoneAttrs] = defineField('phone', {
  validateOnModelUpdate: false,
});
const [bio, bioAttrs] = defineField('bio', { validateOnModelUpdate: false });

// 表单只在「对话框打开」这一刻用当前用户信息初始化一次。
// 依赖数组刻意不含 user：上传头像成功后 useUploadAvatar 会 setUser() 换掉用户引用，
// 若把 user 放进依赖，effect 会重跑 reset()，把 isDirty 冲回 false，「保存」随即变灰点不动。
// Vue 里直接读 store 上的最新 user 即可（pinia store 为单例，等价 React 的 getState()）。
watch(
  () => props.open,
  (open) => {
    if (open) {
      const currentUser = authStore.user;
      resetForm({
        values: {
          avatar: currentUser?.avatar ?? '',
          name: currentUser?.name ?? '',
          phone: currentUser?.phone ?? '',
          bio: currentUser?.bio ?? '',
        },
      });
    }
  },
);

const avatarValue = computed(() => avatar.value ?? '');
const nameValue = computed(() => name.value ?? '');
const bioCount = computed(() => (bio.value ?? '').length);

const isUploading = computed(() => uploadMutation.isPending.value);
const isPending = computed(() => updateMutation.isPending.value);
const isBusy = computed(() => isUploading.value || isPending.value);

/** 仅 http(s) 外链才回灌输入框；站内上传路径（/api/uploads/... 等相对路径）不对外暴露 */
const isExternalUrl = (v: string): boolean => /^https?:\/\//i.test(v);

/** 当前头像来自本地上传（有值但不是外链） */
const isUploadedAvatar = computed(
  () => Boolean(avatarValue.value) && !isExternalUrl(avatarValue.value),
);

/** 头像 URL 输入框当前展示值：站内上传路径不对外暴露，故回填空串 */
const urlInputDisplay = computed(() =>
  isUploadedAvatar.value ? '' : avatarValue.value,
);

/**
 * 头像 URL 输入框的输入直接写进表单 avatar 字段（随「保存」一起提交）。
 * 不再有独立的 [应用] 步骤；zod 校验在提交时才生效，非法值会被「保存」拦截并提示。
 */
const handleAvatarUrlChange = (event: Event): void => {
  if (isBusy.value) {
    return;
  }
  const value = (event.target as HTMLInputElement).value;
  setFieldValue('avatar', value);
};

/** 打开系统文件选择器 */
const handlePickFile = (): void => {
  if (isBusy.value) {
    return;
  }
  fileInputRef.value?.click();
};

/**
 * 文件选择回调：前端预校验不通过时只提示、不发请求，
 * 避免把明显非法的文件推到后端换一个更慢的 400。
 */
const handleFileChange = (event: Event): void => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 立即清空 input.value，保证同一个文件连续选两次也能再次触发 change
  input.value = '';
  if (!file) {
    return;
  }

  if (!ACCEPTED_IMAGE_MIME.includes(file.type as (typeof ACCEPTED_IMAGE_MIME)[number])) {
    toast.error('仅支持 JPG / PNG / WebP 格式的图片');
    return;
  }
  if (file.size > MAX_AVATAR_SIZE) {
    toast.error('图片大小不能超过 2MB');
    return;
  }

  uploadMutation.mutate(file, {
    onSuccess: (data) => {
      // 写回表单：既用于本地预览，也让「保存」时把新地址一并提交
      setFieldValue('avatar', data.url);
    },
  });
};

/**
 * 移除头像：直接 PATCH avatar='' 让后端置 NULL。
 * 磁盘上的旧文件不在此处删除（下次上传新头像时由后端顺带清理）。
 */
const handleRemoveAvatar = (): void => {
  if (isBusy.value || !avatarValue.value) {
    return;
  }
  updateMutation.mutate(
    { avatar: '' },
    {
      onSuccess: () => {
        setFieldValue('avatar', '');
      },
    },
  );
};

const onSubmit = handleSubmit((values) => {
  // 未填字段归一为 ''，明确表达「清空」语义
  updateMutation.mutate(
    {
      name: values.name ?? '',
      avatar: values.avatar ?? '',
      phone: values.phone ?? '',
      bio: values.bio ?? '',
    },
    { onSuccess: () => emit('openChange', false) },
  );
});
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => emit('openChange', v)">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>编辑资料</DialogTitle>
        <DialogDescription>
          点击头像可更换图片，其余字段留空表示清除该项
        </DialogDescription>
      </DialogHeader>
      <form @submit="onSubmit">
        <div class="space-y-4">
          <!-- 头像上传区 -->
          <div class="flex items-center gap-4">
            <div class="group relative h-16 w-16 shrink-0">
              <button
                type="button"
                :disabled="isBusy"
                aria-label="更换头像"
                :class="cn(
                  'relative block h-16 w-16 overflow-hidden rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  isBusy && 'cursor-not-allowed',
                )"
                @click="handlePickFile"
              >
                <UserAvatar
                  size="lg"
                  :src="avatarValue || null"
                  :name="nameValue || nameFieldName"
                  :email="userEmail"
                />
                <!-- hover 蒙层 / 上传中遮罩 -->
                <span
                  :class="isUploading
                    ? 'absolute inset-0 flex items-center justify-center rounded-full bg-black/50 text-white opacity-100'
                    : 'absolute inset-0 flex flex-col items-center justify-center gap-0.5 rounded-full bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100'"
                >
                  <Loader2 v-if="isUploading" class="h-5 w-5 animate-spin" />
                  <template v-else>
                    <Camera class="h-4 w-4" />
                    <span class="text-[10px] leading-none">更换头像</span>
                  </template>
                </span>
              </button>

              <!-- 移除头像：仅在已有头像且非忙碌时出现 -->
              <button
                v-if="avatarValue && !isUploading"
                type="button"
                :disabled="isBusy"
                aria-label="移除头像"
                title="移除头像"
                :class="cn(
                  'absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-background bg-destructive text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isBusy && 'cursor-not-allowed',
                )"
                @click="handleRemoveAvatar"
              >
                <X class="h-3 w-3" />
              </button>
            </div>

            <div class="flex-1 space-y-1">
              <Label>头像</Label>
              <p class="text-xs text-muted-foreground">
                支持 JPG / PNG / WebP，大小不超过 2MB
              </p>
              <p v-if="errors.avatar" class="text-xs text-destructive">
                {{ errors.avatar }}
              </p>
            </div>

            <!-- 隐藏的文件输入框 + avatar 只读字段（值由上传/URL 流程写入，随「保存」一起提交） -->
            <input
              ref="fileInputRef"
              type="file"
              class="hidden"
              :accept="ACCEPT_ATTR"
              @change="handleFileChange"
            />
            <input type="hidden" v-bind="avatarAttrs" />
          </div>

          <!-- 头像 URL：与本地上传并列，最后生效者覆盖前者，随「保存」一起提交 -->
          <div class="space-y-1.5">
            <Label for="profile-avatar-url">头像 URL</Label>
            <Input
              id="profile-avatar-url"
              type="text"
              inputmode="url"
              :placeholder="isUploadedAvatar ? '已通过本地上传设置头像' : 'https://example.com/avatar.png'"
              :value="urlInputDisplay"
              :disabled="isBusy"
              @input="handleAvatarUrlChange"
              @keydown.enter.prevent
            />
            <p class="text-xs text-muted-foreground">
              输入图片 URL 后将随「保存」一起提交生效；与本地上传并列，
              二者最后生效者覆盖前者。本地上传的头像不会显示为
              URL（站内路径不对外暴露）；此处仅用于粘贴外部图片地址
            </p>
          </div>

          <div class="space-y-2">
            <Label for="profile-name">昵称</Label>
            <Input
              id="profile-name"
              placeholder="如：张三"
              v-model="name"
              v-bind="nameAttrs"
            />
            <p v-if="errors.name" class="text-xs text-destructive">
              {{ errors.name }}
            </p>
          </div>
          <div class="space-y-2">
            <Label for="profile-phone">手机号</Label>
            <Input
              id="profile-phone"
              inputmode="numeric"
              placeholder="13800138000"
              v-model="phone"
              v-bind="phoneAttrs"
            />
            <p v-if="errors.phone" class="text-xs text-destructive">
              {{ errors.phone }}
            </p>
          </div>
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <Label for="profile-bio">个人简介</Label>
              <span class="text-xs text-muted-foreground">
                {{ bioCount }}/200
              </span>
            </div>
            <Textarea
              id="profile-bio"
              :rows="3"
              placeholder="一句话介绍自己的投资风格"
              v-model="bio"
              v-bind="bioAttrs"
            />
            <p v-if="errors.bio" class="text-xs text-destructive">
              {{ errors.bio }}
            </p>
          </div>
        </div>
        <DialogFooter class="mt-6">
          <Button
            type="button"
            variant="outline"
            :disabled="isBusy"
            @click="emit('openChange', false)"
          >
            取消
          </Button>
          <Button type="submit" :disabled="isBusy || !meta.dirty">
            <Loader2 v-if="isPending" class="mr-2 h-4 w-4 animate-spin" />
            保存
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>