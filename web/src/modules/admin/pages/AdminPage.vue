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
import { Plus, ServerCog, Tags, ListChecks, type LucideIcon } from 'lucide-vue-next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useIsAdmin } from '@/stores/auth.store';
import { usePersistentTab } from '@/composables/use-persistent-tab';
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

const MODULE_KEYS = MODULES.map((m) => m.key);

const isAdmin = useIsAdmin();
/** 当前激活子模块：持久化到 localStorage，刷新后仍停留当前分页 */
const active = usePersistentTab(ADMIN_MODULE_KEY, MODULES[0].key, MODULE_KEYS);

/** 数据来源板块 ref：顶层「新增数据来源」按钮调用其 openCreate（对齐定时任务页 Tab 栏右侧操作） */
const quoteProviderRef = ref<InstanceType<typeof QuoteProviderSection> | null>(null);
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
      <Tabs v-model="active">
        <div class="flex items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger v-for="m in MODULES" :key="m.key" :value="m.key">
              <component :is="m.icon" class="mr-2 h-4 w-4" />
              {{ m.label }}
            </TabsTrigger>
          </TabsList>
          <Button v-if="active === 'quote-provider'" size="sm" @click="quoteProviderRef?.openCreate()">
            <Plus class="mr-1 h-4 w-4" />
            新增数据来源
          </Button>
        </div>
      </Tabs>

      <QuoteProviderSection v-if="active === 'quote-provider'" ref="quoteProviderRef" />
      <InterfaceCategorySection v-else-if="active === 'interface-category'" />
      <StockListTestSection v-else />
    </template>
  </div>
</template>