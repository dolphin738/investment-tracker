<script setup lang="ts">
/**
 * modules/account/components/AccountInfoCard.vue — 账户资料卡
 *
 * 展示当前登录用户的个人资料（头像 / 昵称 / 邮箱 / 手机脱敏 / 简介 / 注册时间），
 * 并提供「编辑资料 / 改邮箱 / 改密码」三个安全与资料维护入口。
 * 具体操作由父级 AccountPage 挂载的三个对话框完成，本组件仅向上派发事件。
 */
import { computed } from 'vue';
import { Calendar, Mail, Phone } from 'lucide-vue-next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import UserAvatar from '@/components/common/UserAvatar.vue';
import { formatDate } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';

defineEmits<{
  editProfile: [];
  changeEmail: [];
  changePassword: [];
}>();

const authStore = useAuthStore();
const user = authStore.user;

const displayName = computed(() => user?.name || '未设置昵称');
const userEmail = computed(() => user?.email ?? '');

/** 手机号脱敏（与 React 版 pages/AccountPage.tsx 的 maskPhone 一致） */
const maskPhone = computed<string>(() => {
  const phone = user?.phone;
  if (!phone) return '-';
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
});
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">个人信息</CardTitle>
    </CardHeader>
    <CardContent class="flex flex-col items-center gap-4">
      <UserAvatar
        size="lg"
        :src="user?.avatar"
        :name="user?.name"
        :email="userEmail"
      />
      <div class="w-full space-y-2 text-center">
        <h3 class="text-lg font-semibold">{{ displayName }}</h3>
        <div class="flex items-center justify-center gap-1 text-sm text-muted-foreground">
          <Mail class="h-3.5 w-3.5" />
          {{ userEmail || '-' }}
        </div>
        <div class="flex items-center justify-center gap-1 text-sm text-muted-foreground">
          <Phone class="h-3.5 w-3.5" />
          {{ maskPhone }}
        </div>
        <div class="flex items-center justify-center gap-1 text-sm text-muted-foreground">
          <Calendar class="h-3.5 w-3.5" />
          注册于 {{ formatDate(user?.createdAt) }}
        </div>
        <p v-if="user?.bio" class="text-sm text-muted-foreground">
          {{ user.bio }}
        </p>
      </div>
      <div class="mt-auto flex w-full flex-col gap-2">
        <Button variant="outline" size="sm" @click="$emit('editProfile')">
          编辑资料
        </Button>
        <div class="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            class="flex-1"
            @click="$emit('changeEmail')"
          >
            修改邮箱
          </Button>
          <Button
            variant="ghost"
            size="sm"
            class="flex-1"
            @click="$emit('changePassword')"
          >
            修改密码
          </Button>
        </div>
      </div>
    </CardContent>
  </Card>
</template>