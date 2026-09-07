<script setup lang="ts">
/**
 * modules/admin/pages/GlobalSettingsPage.vue — 系统管理「全局设置」页
 *
 * 承接自设置页迁出的全局配置 TAB（方案 §10.4：股息率设置整体迁入本页）。
 * 首期仅「股息率」TAB（承载 GlobalSettingsDividendTab），预留未来其他全局设置 TAB 插槽。
 * 仅管理员可见：非管理员整页「无权限访问该页面」（同 AdminPage 守卫口径，
 * 后端仍 403 兜底）。
 */

import { ref } from 'vue';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useIsAdmin } from '@/stores/auth.store';
import PageHeader from '@/components/common/PageHeader.vue';
import GlobalSettingsDividendTab from '../components/GlobalSettingsDividendTab.vue';

const isAdmin = useIsAdmin();
/** 当前激活子 TAB（首期仅股息率） */
const active = ref('dividend');
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="全局设置" />

    <!-- 非管理员：无权限 -->
    <Card v-if="!isAdmin">
      <CardContent class="py-10 text-center text-sm text-muted-foreground">
        无权限访问该页面
      </CardContent>
    </Card>

    <template v-else>
      <Tabs v-model="active">
        <TabsList>
          <TabsTrigger value="dividend">股息率</TabsTrigger>
        </TabsList>
      </Tabs>

      <GlobalSettingsDividendTab v-if="active === 'dividend'" />
    </template>
  </div>
</template>
