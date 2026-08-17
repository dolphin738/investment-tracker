<script setup lang="ts">
/**
 * modules/admin/pages/AdminPage.vue — 金融数据接口页（仅管理员可见）
 *
 * 平移自 React 版 pages/admin.tsx，行为契约一致。
 * 仅管理员可见：非管理员整页「无权限访问该页面」。
 * 页面内以标签页（分页）形式呈现「接口API来源」「接口分类管理」「股票列表和测试」三个模块，
 * 点击标签切换即渲染对应内容（MODULES 注册表，新增板块只需追加一条）。
 * 当前激活子模块持久化到 localStorage，刷新后仍停留在同一分页。
 */

import { ref } from 'vue';
import { ServerCog, Tags, ListChecks, type LucideIcon } from 'lucide-vue-next';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useIsAdmin } from '@/stores/auth.store';
import QuoteProviderSection from '../components/QuoteProviderSection.vue';
import InterfaceCategorySection from '../components/InterfaceCategorySection.vue';
import StockListTestSection from '../components/StockListTestSection.vue';

/** 当前激活子模块持久化键：刷新网页后仍停留在同一分页（而非回到默认第一个） */
const ADMIN_MODULE_KEY = 'invest:admin-active-module';

interface AdminModule {
  key: string;
  label: string;
  icon: LucideIcon;
  component: 'quote-provider' | 'interface-category' | 'stock-list-test';
}

const MODULES: AdminModule[] = [
  {
    key: 'quote-provider',
    label: '接口API来源',
    icon: ServerCog,
    component: 'quote-provider',
  },
  {
    key: 'interface-category',
    label: '接口分类管理',
    icon: Tags,
    component: 'interface-category',
  },
  {
    key: 'stock-list-test',
    label: '股票列表和测试',
    icon: ListChecks,
    component: 'stock-list-test',
  },
];

/** 按 key 检索模块；未命中回退到第一个模块 */
function findModule(key: string): AdminModule {
  return MODULES.find((m) => m.key === key) ?? MODULES[0];
}

function readStoredModule(): string {
  try {
    const v = localStorage.getItem(ADMIN_MODULE_KEY);
    return v && MODULES.some((m) => m.key === v) ? v : MODULES[0].key;
  } catch {
    return MODULES[0].key;
  }
}

function storeModule(key: string): void {
  try {
    localStorage.setItem(ADMIN_MODULE_KEY, key);
  } catch {
    /* 隐私模式 / 配额：忽略持久化失败 */
  }
}

const isAdmin = useIsAdmin();
const active = ref<string>(readStoredModule());
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-bold tracking-tight">金融数据接口</h1>

    <!-- 非管理员：无权限 -->
    <Card v-if="!isAdmin">
      <CardContent class="py-10 text-center text-sm text-muted-foreground">
        无权限访问该页面
      </CardContent>
    </Card>

    <template v-else>
      <div class="mb-4 flex flex-wrap gap-2">
        <button
          v-for="m in MODULES"
          :key="m.key"
          type="button"
          :class="cn(
            'flex items-center rounded-md border px-3 py-1.5 text-sm transition-colors',
            active === m.key
              ? 'border-primary bg-primary/10 font-medium text-primary'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )"
          @click="
            () => {
              active = m.key;
              storeModule(m.key);
            }
          "
        >
          <component :is="m.icon" class="mr-2 h-4 w-4" />
          {{ m.label }}
        </button>
      </div>

      <QuoteProviderSection v-if="active === 'quote-provider'" />
      <InterfaceCategorySection v-else-if="active === 'interface-category'" />
      <StockListTestSection v-else />
    </template>
  </div>
</template>