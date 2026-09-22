<script setup lang="ts">
/**
 * modules/admin/pages/GlobalSettingsPage.vue — 系统管理「全局设置」页
 *
 * 顶层 TAB：[初始化][股息率]（初始化在前、默认激活）。两份内容均为哑组件，**唯一一份**
 * settingsForm 状态与读写逻辑上移到本页（父持有、子哑）——两个 TAB 共享同一 form、共用同一
 * 保存按钮（PUT 是全字段，两个各自发一次会互相覆盖，故严禁）。
 * 仅管理员可见：非管理员整页「无权限访问该页面」（同 AdminPage 守卫口径，后端仍 403 兜底）。
 *
 * 注：原「回补行情缺口」相关配置（历史行情回补接口、每日回补额度、回补起始日期、回补模式、
 * 回补复权方式）已随价格缺口回补功能下线一并移除，仅保留「交易日历起始日期」配置项。
 */
import { computed, reactive, ref, watch } from 'vue';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2 } from 'lucide-vue-next';
import { useIsAdmin } from '@/stores/auth.store';
import PageHeader from '@/components/common/PageHeader.vue';
import GlobalSettingsDividendTab from '../components/GlobalSettingsDividendTab.vue';
import GlobalSettingsDividendInitSection from '../components/GlobalSettingsDividendInitSection.vue';
import {
  useDividendYieldInterfaces,
  useDividendYieldSettings,
  useUpdateDividendYieldSettings,
} from '@/modules/dividend-yield/composables/use-dividend-yield';
import { useQuoteProviders } from '@/modules/admin/composables/use-quote-provider';
import { SELECT_EMPTY_VALUE } from '@/lib/constants';
import type { UpdateDividendYieldSettingsDto } from '@/api/types';

const isAdmin = useIsAdmin();
/** 当前激活子 TAB；初始化在前（默认激活），股息率次之 */
const active = ref('init');

// ───────────────────────── 数据层 ─────────────────────────
const settingsQuery = useDividendYieldSettings(true);
const dividendSettings = computed(() => settingsQuery.data.value);
const settingsLoading = computed(() => settingsQuery.isLoading.value);
const settingsMutation = useUpdateDividendYieldSettings();
const settingsPending = computed(() => settingsMutation.isPending.value);
const settingsError = computed(() => settingsMutation.isError.value);

// 四源候选接口（复用 listAllInterfaces，前端按 category_id 过滤）
const interfacesQuery = useDividendYieldInterfaces(true);
const category3Enabled = computed(() =>
  (interfacesQuery.data.value ?? []).filter((i) => i.category_id === '3' && i.enabled),
);
/** 股息明细源接口候选（category_id === '3' && enabled） */
const dividendDetailOptions = category3Enabled;
/** 行情源候选（category_id === '2'） */
const priceSourceOptions = computed(() =>
  (interfacesQuery.data.value ?? []).filter((i) => i.category_id === '2' && i.enabled),
);
/** 公司公告接口候选（category_id === '4' && enabled） */
const announcementSourceOptions = computed(() =>
  (interfacesQuery.data.value ?? []).filter((i) => i.category_id === '4' && i.enabled),
);

// 提供方 id → 名称：四个源下拉展示接口归属（如「东财-分红配送（东方财富）」）
const { data: providers } = useQuoteProviders();
const providerNameById = computed(() => {
  const m = new Map<string, string>();
  (providers.value ?? []).forEach((p) => m.set(p.id, p.name));
  return m;
});

// ───────────────────────── 表单（唯一状态源） ─────────────────────────
// 接口下拉的「不设置」用 SELECT_EMPTY_VALUE 表示（reka-ui 禁止 value=""）。
const settingsForm = reactive({
  dividendDetailSourceInterfaceId: SELECT_EMPTY_VALUE,
  priceSourceInterfaceId: SELECT_EMPTY_VALUE,
  announcementSourceInterfaceId: SELECT_EMPTY_VALUE,
  /** 交易日历刷新起始日期（YYYY-MM-DD）；空串 = 未配置（后端默认「去年 1 月 1 日」） */
  tradeCalendarStartDate: '',
});
const settingsFormError = ref('');

/** 表单下拉值 → 提交值：哨兵 / 空串一律视为「不设置」（null）。 */
function toInterfaceIdOrNull(v: string): string | null {
  return v === SELECT_EMPTY_VALUE ? null : v || null;
}

// immediate 必填：服务端数据到达（或缓存命中重挂载）时须立即回填表单。
// 非 immediate 的 watch 在缓存命中重挂载时不会触发（同 SettingsPreferencesTab 已修的坑）。
watch(
  dividendSettings,
  (s) => {
    if (!s) return;
    settingsForm.dividendDetailSourceInterfaceId =
      s.dividend_detail_source?.id ?? SELECT_EMPTY_VALUE;
    settingsForm.priceSourceInterfaceId = s.price_source?.id ?? SELECT_EMPTY_VALUE;
    settingsForm.announcementSourceInterfaceId =
      s.announcement_source?.id ?? SELECT_EMPTY_VALUE;
    // 交易日历刷新起始日期：服务端 null → 空串（未配置，后端用默认下限）
    settingsForm.tradeCalendarStartDate = s.trade_calendar_start_date ?? '';
  },
  { immediate: true },
);

/** 是否有本地变更（与服务端对比） */
const settingsHasChanges = computed(() => {
  const s = dividendSettings.value;
  if (!s) return false;
  return (
    settingsForm.dividendDetailSourceInterfaceId !==
      (s.dividend_detail_source?.id ?? SELECT_EMPTY_VALUE) ||
    settingsForm.priceSourceInterfaceId !==
      (s.price_source?.id ?? SELECT_EMPTY_VALUE) ||
    settingsForm.announcementSourceInterfaceId !==
      (s.announcement_source?.id ?? SELECT_EMPTY_VALUE) ||
    // 交易日历刷新起始日期：服务端 null → 空串，与 watch 回填口径一致
    settingsForm.tradeCalendarStartDate !== (s.trade_calendar_start_date ?? '')
  );
});

/** 保存全局设置（覆盖两个 TAB 的全部字段） */
function handleSaveSettings(): void {
  settingsFormError.value = '';
  const payload: UpdateDividendYieldSettingsDto = {
    dividend_detail_source_interface_id: toInterfaceIdOrNull(
      settingsForm.dividendDetailSourceInterfaceId,
    ),
    price_source_interface_id: toInterfaceIdOrNull(
      settingsForm.priceSourceInterfaceId,
    ),
    announcement_source_interface_id: toInterfaceIdOrNull(
      settingsForm.announcementSourceInterfaceId,
    ),
    // 交易日历刷新起始日期：空串 → null（后端视为「不改」）
    trade_calendar_start_date: settingsForm.tradeCalendarStartDate || null,
  };
  settingsMutation.mutate(payload);
}
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
          <TabsTrigger value="init">初始化</TabsTrigger>
          <TabsTrigger value="dividend">股息率</TabsTrigger>
        </TabsList>
      </Tabs>

      <div v-if="settingsLoading" class="space-y-3">
        <Skeleton v-for="i in 4" :key="i" class="h-10 w-full" />
      </div>
      <template v-else>
        <!-- 初始化 TAB：交易日历配置 + 冷启动手工动作 -->
        <Card v-if="active === 'init'">
          <CardHeader>
            <CardTitle class="text-base">初始化</CardTitle>
            <CardDescription>
              冷启动 / 数据修复用的配置与手工动作；触发后任务在后台执行，进度见应用日志。
            </CardDescription>
          </CardHeader>
          <CardContent class="space-y-6">
            <GlobalSettingsDividendInitSection
              v-model:trade-calendar-start-date="settingsForm.tradeCalendarStartDate"
            />
          </CardContent>
        </Card>

        <!-- 股息率 TAB：四源接口（阈值已迁「个人中心 → 偏好设置」，本页不再承载） -->
        <GlobalSettingsDividendTab
          v-else
          v-model:dividend-detail-source-interface-id="
            settingsForm.dividendDetailSourceInterfaceId
          "
          v-model:price-source-interface-id="settingsForm.priceSourceInterfaceId"
          v-model:announcement-source-interface-id="
            settingsForm.announcementSourceInterfaceId
          "
          :dividend-detail-options="dividendDetailOptions"
          :price-source-options="priceSourceOptions"
          :announcement-source-options="announcementSourceOptions"
          :provider-name-by-id="providerNameById"
        />

        <!-- 保存按钮置于页面层：两个 TAB 均可见、共用同一份 settings（PUT 全字段，严禁两处各发一次） -->
        <p v-if="settingsFormError" class="text-xs text-red-500">
          {{ settingsFormError }}
        </p>
        <div class="flex items-center gap-3">
          <Button
            :disabled="!settingsHasChanges || settingsPending"
            @click="handleSaveSettings"
          >
            <Loader2 v-if="settingsPending" class="mr-2 h-4 w-4 animate-spin" />
            保存设置
          </Button>
          <span v-if="settingsError" class="text-xs text-red-500">
            保存失败，请重试
          </span>
          <span
            v-if="settingsHasChanges && !settingsPending"
            class="text-xs text-muted-foreground"
          >
            有未保存的更改
          </span>
        </div>
      </template>
    </template>
  </div>
</template>
