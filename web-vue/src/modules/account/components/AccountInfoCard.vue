<script setup lang="ts">
/**
 * modules/account/components/AccountInfoCard.vue — 个人信息卡（只读 · ACC-P0-02）
 *
 * 对齐 React 版 web/src/pages/AccountPage.tsx「个人信息」卡契约：
 * - 只读展示：头像 / 昵称 / 邮箱 / 手机（脱敏）/ 简介 / 注册时间；
 * - **卡内无任何修改控件**（§7.7 组合管理平面收敛后的新契约）：
 *   资料与安全修改在设置页，卡内仅提供「前往设置修改 →」跳转链接。
 * - 数据源优先 GET /auth/profile（useProfile）的新鲜响应（回写 auth store），
 *   回退 auth store 从 localStorage 恢复的旧缓存（旧缓存可能缺 createdAt）。
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { Calendar, Mail, Phone } from 'lucide-vue-next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import UserAvatar from '@/components/common/UserAvatar.vue';
import { formatDate } from '@/lib/utils';
import { ROUTE_PATH } from '@/lib/constants';
import { useAuthStore } from '@/stores/auth.store';
import { useProfile } from '@/modules/auth/composables/use-auth';

const router = useRouter();
const authStore = useAuthStore();
const profile = useProfile();

/** 优先用 profile 新鲜响应，回退 auth store（React: profile.data ?? user） */
const currentUser = computed(() => profile.data.value ?? authStore.user);

const displayName = computed(() => currentUser.value?.name || '未设置昵称');
const userEmail = computed(() => currentUser.value?.email ?? '');

/** 手机号脱敏（与 React 版 pages/AccountPage.tsx 的 maskPhone 一致） */
const maskPhone = computed<string>(() => {
  const phone = currentUser.value?.phone;
  if (!phone) return '-';
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
});

/** 前往设置页修改资料与安全（账户页唯一入口跳转） */
function goSettings(): void {
  router.push(ROUTE_PATH.SETTINGS);
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">个人信息</CardTitle>
    </CardHeader>
    <CardContent class="flex flex-col items-center gap-4">
      <UserAvatar
        size="lg"
        :src="currentUser?.avatar"
        :name="currentUser?.name"
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
          注册于 {{ formatDate(currentUser?.createdAt) }}
        </div>
        <p v-if="currentUser?.bio" class="text-sm text-muted-foreground">
          {{ currentUser.bio }}
        </p>
      </div>
      <!-- 卡内无任何修改控件（§7.7）：资料/安全修改仍在设置页，仅提供跳转 -->
      <Button variant="link" size="sm" class="mt-auto" @click="goSettings">
        前往设置修改 →
      </Button>
    </CardContent>
  </Card>
</template>
