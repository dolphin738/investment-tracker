<script setup lang="ts">
/**
 * components/layout/AppLayout.vue — 主布局
 *
 * 顶部导航栏（Logo + 基准时钟 + 组合选择器 + 用户菜单）+ 侧边导航 + 内容区。
 * 响应式：桌面侧栏常驻，移动端折叠为汉堡菜单。
 *
 * B3 批次：补全组合切换器（PortfolioSelector）与新建组合对话框（PortfolioDialog）。
 * B4 批次：受保护路由内挂 PreferenceBootstrap（服务端偏好引导加载 + 默认组合生效）。
 * 通知铃 / 路由持久化属后续批次，此处不占位。
 */

import { onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterView, useRouter } from 'vue-router';
import { CalendarDays, LogOut, Menu, Settings, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import UserAvatar from '@/components/common/UserAvatar.vue';
import Sidebar from './Sidebar.vue';
import PortfolioSelector from '@/modules/portfolio/components/PortfolioSelector.vue';
import PortfolioDialog from '@/modules/portfolio/components/PortfolioDialog.vue';
import PreferenceBootstrap from '@/modules/overview/components/PreferenceBootstrap.vue';
import { useAuthStore, useIsAdmin } from '@/stores/auth.store';
import { APP_NAME, ROUTE_PATH, nowInAppTzIso } from '@/lib/constants';

/**
 * BaselineClock — 顶栏「项目基准时间」实时时钟。
 *
 * 显示北京时间（UTC+8）的「日期 + 时间」(YYYY-MM-DD HH:mm:ss)，
 * 每秒刷新一次。仅重渲该 span，不波及其它顶栏组件。
 * 复用 lib/constants.nowInAppTzIso()（位移 +8h 仅配 toISOString），
 * 保证时区鲁棒性。
 */
const now = ref(nowInAppTzIso());
let clockTimer: number | undefined;

onMounted(() => {
  now.value = nowInAppTzIso();
  clockTimer = window.setInterval(() => {
    now.value = nowInAppTzIso();
  }, 1000);
});

onBeforeUnmount(() => {
  if (clockTimer !== undefined) {
    window.clearInterval(clockTimer);
  }
});

const router = useRouter();
const auth = useAuthStore();
const isAdmin = useIsAdmin();
const mobileOpen = ref(false);
/** 新建组合对话框显隐（组合切换器「新建组合」入口触发） */
const portfolioDialogOpen = ref(false);

/** 退出登录：清空认证态并跳转登录页 */
function handleLogout(): void {
  auth.logout();
  router.push(ROUTE_PATH.LOGIN);
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-background">
    <!-- 顶部导航栏 -->
    <header class="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background px-4">
      <div class="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          class="md:hidden"
          aria-label="切换导航"
          @click="mobileOpen = !mobileOpen"
        >
          <X v-if="mobileOpen" class="h-5 w-5" />
          <Menu v-else class="h-5 w-5" />
        </Button>
        <div class="flex items-center gap-2">
          <span class="text-lg font-bold tracking-tight">{{ APP_NAME }}</span>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <span
          class="hidden items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground sm:flex"
          title="项目基准日期时间（北京时间 UTC+8）"
        >
          <CalendarDays class="h-3.5 w-3.5" />
          {{ now }}
        </span>

        <!-- 组合切换器（含「新建组合」内联入口） -->
        <PortfolioSelector :on-create-click="() => (portfolioDialogOpen = true)" />

        <DropdownMenu>
          <DropdownMenuTrigger
            class="flex h-9 items-center gap-2 rounded-md px-2 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="用户菜单"
          >
            <UserAvatar
              size="sm"
              :src="auth.user?.avatar"
              :name="auth.user?.name"
              :email="auth.user?.email ?? ''"
            />
            <span class="hidden max-w-[8rem] truncate text-sm md:inline">
              {{ auth.user?.name || auth.user?.email || '用户' }}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-56">
            <DropdownMenuLabel>
              <div class="flex items-center gap-2">
                <UserAvatar
                  size="sm"
                  :src="auth.user?.avatar"
                  :name="auth.user?.name"
                  :email="auth.user?.email ?? ''"
                />
                <div class="flex min-w-0 flex-col">
                  <span class="truncate text-sm font-medium">
                    {{ auth.user?.name || auth.user?.email || '用户' }}
                  </span>
                  <span
                    v-if="auth.user?.email"
                    class="truncate text-xs font-normal text-muted-foreground"
                  >
                    {{ auth.user.email }}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem @click="router.push(ROUTE_PATH.SETTINGS)">
              <Settings class="mr-2 h-4 w-4" />
              设置
            </DropdownMenuItem>
            <DropdownMenuItem @click="handleLogout">
              <LogOut class="mr-2 h-4 w-4" />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>

    <div class="flex flex-1">
      <!-- 侧边导航：桌面常驻 -->
      <aside class="hidden w-[200px] shrink-0 border-r bg-card md:block">
        <Sidebar />
      </aside>

      <!-- 移动端侧栏：条件渲染 -->
      <div v-if="mobileOpen" class="fixed inset-0 z-20 md:hidden">
        <div class="absolute inset-0 bg-black/40" @click="mobileOpen = false" />
        <aside class="absolute left-0 top-0 h-full w-[240px] border-r bg-card">
          <Sidebar @navigate="mobileOpen = false" />
        </aside>
      </div>

      <!-- 主内容区（PreferenceBootstrap：首屏引导加载服务端偏好 + 默认组合生效） -->
      <main class="mx-auto w-full max-w-[1440px] flex-1 overflow-x-hidden p-4 md:p-6">
        <PreferenceBootstrap>
          <RouterView />
        </PreferenceBootstrap>
      </main>
    </div>

    <!-- 新建组合对话框 -->
    <PortfolioDialog
      :open="portfolioDialogOpen"
      @open-change="(v: boolean) => (portfolioDialogOpen = v)"
    />
  </div>
</template>
