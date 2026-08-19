<script setup lang="ts">
/**
 * components/layout/Sidebar.vue — 侧边导航
 *
 * 导航项（顺序固定，PRD §7）：概览 / 持仓 / 出入金 / 资产记录 / 收益分析 / 净值分析 / 账户 / 设置
 *
 * 「系统管理」为可折叠分组（仅管理员可见）：其下子项「金融数据接口」「定时任务」。
 * 折叠交互（展开/收起）发生在本主侧边栏，不在各管理页内部。
 */

import { computed, ref, type Component } from 'vue';
import { RouterLink } from 'vue-router';
import {
  ArrowLeftRight,
  Briefcase,
  Camera,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  LayoutDashboard,
  LineChart,
  Settings,
  Shield,
  TrendingUp,
  User,
} from 'lucide-vue-next';
import { ROUTE_PATH } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useIsAdmin } from '@/stores/auth.store';

interface NavChild {
  to: string;
  label: string;
  icon: Component;
}

interface NavItem {
  to?: string;
  label: string;
  icon: Component;
  /** 仅管理员可见的导航项（如「系统管理」） */
  admin?: boolean;
  /** 存在子项时渲染为可折叠分组 */
  children?: NavChild[];
}

const NAV_ITEMS: NavItem[] = [
  { to: ROUTE_PATH.DASHBOARD, label: '概览', icon: LayoutDashboard },
  { to: ROUTE_PATH.HOLDINGS, label: '持仓', icon: Briefcase },
  { to: ROUTE_PATH.TRANSACTIONS, label: '出入金', icon: ArrowLeftRight },
  { to: ROUTE_PATH.SNAPSHOTS, label: '资产记录', icon: Camera },
  { to: ROUTE_PATH.XIRR_ANALYSIS, label: '收益分析', icon: TrendingUp },
  { to: ROUTE_PATH.NAV_ANALYSIS, label: '净值分析', icon: LineChart },
  { to: ROUTE_PATH.ACCOUNT, label: '账户', icon: User },
  { to: ROUTE_PATH.SETTINGS, label: '设置', icon: Settings },
  {
    label: '系统管理',
    icon: Shield,
    admin: true,
    children: [
      { to: ROUTE_PATH.ADMIN, label: '金融数据接口', icon: Database },
      { to: ROUTE_PATH.ADMIN_TASKS, label: '定时任务', icon: Clock },
    ],
  },
];

const props = defineProps<{
  class?: string;
}>();

const emit = defineEmits<{ navigate: [] }>();

// 非管理员过滤掉 admin 标记的入口，避免越权可见（后端同样按 require_admin 拦截）
const isAdmin = useIsAdmin();
const visibleItems = computed(() =>
  NAV_ITEMS.filter((item) => !item.admin || isAdmin),
);

/** 「系统管理」分组折叠状态（默认展开，与 React 版一致） */
const groupOpen = ref(true);

/**
 * 链接激活判断：概览（/）用精确匹配（对应 React 版 end），
 * 其余路径用前缀匹配，避免 /analysis/xirr 同时点亮 /analysis。
 */
function isLinkActive(to: string, isActive: boolean, isExactActive: boolean): boolean {
  return to === ROUTE_PATH.DASHBOARD ? isExactActive : isActive;
}

/** 链接激活态类名（对齐 React 版 NavLink className 逻辑） */
function linkClass(active: boolean): string {
  return cn(
    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
    active
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  );
}
</script>

<template>
  <nav :class="cn('flex flex-col space-y-1 p-3', props.class)">
    <template v-for="item in visibleItems" :key="item.label">
      <!-- 可折叠分组（系统管理） -->
      <div v-if="item.children">
        <button
          type="button"
          :aria-expanded="groupOpen"
          class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          @click="groupOpen = !groupOpen"
        >
          <component :is="item.icon" class="h-4 w-4" />
          <span class="flex-1 text-left">{{ item.label }}</span>
          <ChevronDown v-if="groupOpen" class="h-4 w-4 shrink-0" />
          <ChevronRight v-else class="h-4 w-4 shrink-0" />
        </button>
        <div v-if="groupOpen" class="ml-3 mt-1 space-y-1 border-l pl-3">
          <RouterLink
            v-for="child in item.children"
            :key="child.to"
            v-slot="{ isActive, href, navigate }"
            :to="child.to"
            custom
          >
            <a
              :href="href"
              :class="linkClass(isActive)"
              @click="
                navigate($event);
                emit('navigate');
              "
            >
              <component :is="child.icon" class="h-4 w-4" />
              {{ child.label }}
            </a>
          </RouterLink>
        </div>
      </div>

      <!-- 普通导航项 -->
      <RouterLink
        v-else
        v-slot="{ isActive, isExactActive, href, navigate }"
        :to="item.to!"
        custom
      >
        <a
          :href="href"
          :class="linkClass(isLinkActive(item.to!, isActive, isExactActive))"
          @click="
            navigate($event);
            emit('navigate');
          "
        >
          <component :is="item.icon" class="h-4 w-4" />
          {{ item.label }}
        </a>
      </RouterLink>
    </template>
  </nav>
</template>
