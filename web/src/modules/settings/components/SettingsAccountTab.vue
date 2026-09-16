<script setup lang="ts">
/**
 * modules/settings/components/SettingsAccountTab.vue — 「账户」页签内容
 *
 * 平移自 SettingsPage.vue 账户页签（纯位移，零行为变更）。
 * 纯展示组件：当前用户（门面 useProfile + auth store 派生）与手机号脱敏值
 * 由门面以 props 传入，本组件不新建任何数据 hook；三个账户修改弹窗的
 * 开关与退出登录通过 emit 回传门面既有状态与处理函数。
 */
import { Lock, LogOut, Mail, Pencil } from 'lucide-vue-next';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import UserAvatar from '@/components/common/UserAvatar.vue';
import AssetOverviewCard from '@/modules/account/components/AssetOverviewCard.vue';
import StatsOverviewCard from '@/modules/account/components/StatsOverviewCard.vue';
import PortfolioManagementCard from '@/modules/account/components/PortfolioManagementCard.vue';
import { formatDate } from '@/lib/utils';
import type { UserPublic } from '@/api/types';

defineProps<{
  /** 当前用户（门面 freshProfile ?? authStore.user） */
  currentUser: UserPublic | null | undefined;
  /** 手机号脱敏展示值（门面 maskedPhone） */
  maskedPhone: string;
}>();
const emit = defineEmits<{
  /** 打开「修改邮箱」弹窗（门面 emailDialogOpen = true） */
  openEmailDialog: [];
  /** 打开「修改密码」弹窗（门面 passwordDialogOpen = true） */
  openPasswordDialog: [];
  /** 打开「编辑资料」弹窗（门面 profileDialogOpen = true） */
  openProfileDialog: [];
  /** 退出登录（门面 handleLogout） */
  logout: [];
}>();
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">账户</CardTitle>
      <CardDescription>当前登录用户信息与安全设置</CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <!-- 头像 + 昵称 + 邮箱 -->
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center">
        <UserAvatar
          size="lg"
          :src="currentUser?.avatar"
          :name="currentUser?.name"
          :email="currentUser?.email ?? ''"
        />
        <div class="min-w-0">
          <p class="truncate text-base font-medium">
            {{ currentUser?.name || '未设置' }}
          </p>
          <p class="truncate text-sm text-muted-foreground">
            {{ currentUser?.email ?? '-' }}
          </p>
        </div>
      </div>

      <!-- 资料明细（含原账户页个人信息卡特有的「注册时间」） -->
      <div class="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
        <div>
          <Label class="text-xs text-muted-foreground">手机号</Label>
          <p class="mt-1 font-mono">{{ maskedPhone }}</p>
        </div>
        <div>
          <Label class="text-xs text-muted-foreground">注册时间</Label>
          <p class="mt-1">{{ formatDate(currentUser?.createdAt) }}</p>
        </div>
        <div>
          <Label class="text-xs text-muted-foreground">个人简介</Label>
          <p class="mt-1 whitespace-pre-wrap break-words">
            {{ currentUser?.bio || '-' }}
          </p>
        </div>
      </div>

      <!-- 操作区 -->
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" @click="emit('openEmailDialog')">
          <Mail class="mr-2 h-4 w-4" />
          修改邮箱
        </Button>
        <Button variant="outline" size="sm" @click="emit('openPasswordDialog')">
          <Lock class="mr-2 h-4 w-4" />
          修改密码
        </Button>
        <Button variant="outline" size="sm" @click="emit('openProfileDialog')">
          <Pencil class="mr-2 h-4 w-4" />
          编辑资料
        </Button>
        <Button variant="outline" size="sm" @click="emit('logout')">
          <LogOut class="mr-2 h-4 w-4" />
          退出登录
        </Button>
      </div>

      <!-- 头像修改提示（§7.8 L1318-1319） -->
      <p class="text-xs text-muted-foreground">
        Ⓘ 头像修改在「编辑资料」卡片内完成（本地上传 与 头像 URL 并列）；本区只展示头像，不提供独立的「头像 URL」输入框
      </p>
    </CardContent>
  </Card>

  <!-- 原账户页只读聚合卡（ACC-P0-03 / ACC-P0-06）：资产全景 + 数据统计 -->
  <div class="grid grid-cols-1 gap-6 xl:grid-cols-12">
    <AssetOverviewCard class="xl:col-span-5" />
    <StatsOverviewCard class="xl:col-span-7" />
  </div>

  <!-- 我的组合：全站唯一组合管理平面（ACC-P0-04，可写），独占整行 -->
  <PortfolioManagementCard />
</template>
