<script setup lang="ts">
/**
 * modules/admin/pages/GlobalSettingsPage.vue — 系统管理「全局设置」页
 *
 * 顶层 TAB：[初始化][股息率]（初始化在前、默认激活）。两份内容均为哑组件，**唯一一份**
 * settingsForm 状态与读写逻辑上移到本页（父持有、子哑）——两个 TAB 共享同一 form、共用同一
 * 保存按钮（PUT 是全字段，两个各自发一次会互相覆盖，故严禁）。
 * 仅管理员可见：非管理员整页「无权限访问该页面」（同 AdminPage 守卫口径，后端仍 403 兜底）。
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
import {
  PRICE_BACKFILL_ADJUST_NONE,
  PRICE_BACKFILL_MODE_LEGACY,
  SELECT_EMPTY_VALUE,
} from '@/lib/constants';
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
/** 股息主源 / 补充源候选（category_id === '3'；主源限按报告期全量形态由后端四重校验兜底） */
const dividendSourceOptions = category3Enabled;
const dividendDetailOptions = category3Enabled;
/** 行情源候选（category_id === '2'） */
const priceSourceOptions = computed(() =>
  (interfacesQuery.data.value ?? []).filter((i) => i.category_id === '2' && i.enabled),
);
/** 公司公告源候选（category_id === '4' && enabled） */
const announcementSourceOptions = computed(() =>
  (interfacesQuery.data.value ?? []).filter((i) => i.category_id === '4' && i.enabled),
);
/** 历史行情回补接口候选（category_id === '2' && enabled；契约：证券行情分类） */
const priceBackfillSourceOptions = computed(() =>
  (interfacesQuery.data.value ?? []).filter((i) => i.category_id === '2' && i.enabled),
);
/** 回补接口候选项（id + 拼接好 label），供初始化 TAB 哑组件渲染 */
const priceBackfillInterfaceOptions = computed(() =>
  priceBackfillSourceOptions.value.map((i) => ({
    id: i.id,
    label: `${i.name}（${providerNameById.value.get(i.provider_id) ?? '未知提供方'}）`,
  })),
);

// 提供方 id → 名称：四个源下拉展示接口归属（如「东财-分红配送（东方财富）」）
const { data: providers } = useQuoteProviders();
const providerNameById = computed(() => {
  const m = new Map<string, string>();
  (providers.value ?? []).forEach((p) => m.set(p.id, p.name));
  return m;
});

// ───────────────────────── 表单（唯一状态源） ─────────────────────────
// 阈值以**百分数**存储（5 = 5%），提交时转小数（P2-8 / §2.4）。
// 接口下拉的「不设置」用 SELECT_EMPTY_VALUE 表示（reka-ui 禁止 value=""）。
const settingsForm = reactive({
  greenPercent: '',
  redPercent: '',
  dividendReportSourceInterfaceId: SELECT_EMPTY_VALUE,
  dividendDetailSourceInterfaceId: SELECT_EMPTY_VALUE,
  priceSourceInterfaceId: SELECT_EMPTY_VALUE,
  announcementSourceInterfaceId: SELECT_EMPTY_VALUE,
  priceBackfillSourceInterfaceId: SELECT_EMPTY_VALUE,
  /** 每日回补额度（只/天）；字符串型，保存时转 number（默认 1000 与后端一致） */
  priceBackfillQuota: '1000',
  /** 回补起始日期配置默认值（YYYY-MM-DD）；随设置保存、触发回补以其为起点；默认一年前 */
  priceBackfillStartDate: oneYearAgoIso(),
  /** 历史行情回补模式：'legacy'（起点覆盖即跳过，不补空洞）| 'gap'（严格补洞）；
   *  默认 'legacy' 与后端 server_default 一致 */
  priceBackfillMode: PRICE_BACKFILL_MODE_LEGACY,
  /** 历史行情回补复权方式：''（不复权，默认）| 'qfq'（前复权）| 'hfq'（后复权）；
   *  默认''（不复权）与后端 server_default 一致，零行为变更 */
  priceBackfillAdjust: PRICE_BACKFILL_ADJUST_NONE,
  /** 交易日历刷新起始日期（YYYY-MM-DD）；空串 = 未配置（后端默认「去年 1 月 1 日」） */
  tradeCalendarStartDate: '',
});
const settingsFormError = ref('');

/** 表单下拉值 → 提交值：哨兵 / 空串一律视为「不设置」（null）。 */
function toInterfaceIdOrNull(v: string): string | null {
  return v === SELECT_EMPTY_VALUE ? null : v || null;
}

/** 回补起始日期默认「一年前的今天」（ISO YYYY-MM-DD）；用户可在设置中保存偏好起点 */
function oneYearAgoIso(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

/** 小数比率 → 百分数字符串（0.05 → "5"） */
function ratioToPercent(v: number | null): string {
  return v != null ? String(Number((v * 100).toFixed(4))) : '';
}

// immediate 必填：服务端数据到达（或缓存命中重挂载）时须立即回填表单。
// 非 immediate 的 watch 在缓存命中重挂载时不会触发（同 SettingsPreferencesTab 已修的坑）。
watch(
  dividendSettings,
  (s) => {
    if (!s) return;
    settingsForm.greenPercent = ratioToPercent(s.green_threshold);
    settingsForm.redPercent = ratioToPercent(s.red_threshold);
    settingsForm.dividendReportSourceInterfaceId =
      s.dividend_report_source?.id ?? SELECT_EMPTY_VALUE;
    settingsForm.dividendDetailSourceInterfaceId =
      s.dividend_detail_source?.id ?? SELECT_EMPTY_VALUE;
    settingsForm.priceSourceInterfaceId = s.price_source?.id ?? SELECT_EMPTY_VALUE;
    settingsForm.announcementSourceInterfaceId =
      s.announcement_source?.id ?? SELECT_EMPTY_VALUE;
    settingsForm.priceBackfillSourceInterfaceId =
      s.price_backfill_source?.id ?? SELECT_EMPTY_VALUE;
    // 每日回补额度：服务端 null 时按后端默认 1000 兜底（与保存 payload 口径一致）
    settingsForm.priceBackfillQuota =
      s.price_backfill_quota != null ? String(s.price_backfill_quota) : '1000';
    // 回补起始日期配置默认值：服务端 null 时回退一年前（与 settingsForm 初值口径一致，避免误报变更）
    settingsForm.priceBackfillStartDate =
      s.price_backfill_default_start_date ?? oneYearAgoIso();
    // 回补模式：服务端空值兜底 legacy（列有 server_default，防御旧行/脏数据）
    settingsForm.priceBackfillMode = s.price_backfill_mode || PRICE_BACKFILL_MODE_LEGACY;
    // 回补复权方式：服务端空值兜底 ''（不复权，列有 server_default）
    settingsForm.priceBackfillAdjust =
      s.price_backfill_adjust ?? PRICE_BACKFILL_ADJUST_NONE;
    // 交易日历刷新起始日期：服务端 null → 空串（未配置，后端用默认下限）
    settingsForm.tradeCalendarStartDate = s.trade_calendar_start_date ?? '';
  },
  { immediate: true },
);

/** 百分数字符串 → 小数比率 / null（空串视为 null；非法输入返回 undefined 触发校验错误） */
function percentToRatio(v: string): { ratio: number | null; invalid: boolean } {
  const t = v.trim();
  if (t === '') return { ratio: null, invalid: false };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ratio: null, invalid: true };
  return { ratio: n / 100, invalid: false };
}

/** 每日回补额度字符串 → number | null（空串视为 null；非整数返回 invalid 触发校验错误） */
function quotaToValue(v: string): { value: number | null; invalid: boolean } {
  const t = v.trim();
  if (t === '') return { value: null, invalid: false };
  const n = Number(t);
  if (!Number.isInteger(n)) return { value: null, invalid: true };
  return { value: n, invalid: false };
}

/** 阈值前置校验（后端也会 400：0 < red < green <= 1，即百分数 0 < red% < green% <= 100） */
function validateSettings(): string | null {
  const green = percentToRatio(settingsForm.greenPercent);
  const red = percentToRatio(settingsForm.redPercent);
  if (green.invalid || red.invalid) return '阈值须为有效数字';
  if (green.ratio !== null && green.ratio <= 0) return '绿色阈值须大于 0';
  if (green.ratio !== null && green.ratio > 1) return '绿色阈值须不大于 100（%）';
  if (red.ratio !== null && red.ratio <= 0) return '红色阈值须大于 0';
  if (red.ratio !== null && red.ratio > 1) return '红色阈值须不大于 100（%）';
  if (red.ratio !== null && green.ratio !== null && red.ratio >= green.ratio) {
    return '红色阈值须小于绿色阈值';
  }
  // 每日回补额度（只/天）：后端校验 1..2000 整数，越界返回 400；空串视为 null（用后端默认）
  const q = quotaToValue(settingsForm.priceBackfillQuota);
  if (q.invalid) return '每日回补额度须为整数';
  if (q.value !== null && (q.value < 1 || q.value > 2000)) {
    return '每日回补额度须为 1 到 2000 之间的整数';
  }
  return null;
}

/** 是否有本地变更（与服务端对比，阈值按百分数口径比较） */
const settingsHasChanges = computed(() => {
  const s = dividendSettings.value;
  if (!s) return false;
  return (
    settingsForm.greenPercent !== ratioToPercent(s.green_threshold) ||
    settingsForm.redPercent !== ratioToPercent(s.red_threshold) ||
    settingsForm.dividendReportSourceInterfaceId !==
      (s.dividend_report_source?.id ?? SELECT_EMPTY_VALUE) ||
    settingsForm.dividendDetailSourceInterfaceId !==
      (s.dividend_detail_source?.id ?? SELECT_EMPTY_VALUE) ||
    settingsForm.priceSourceInterfaceId !==
      (s.price_source?.id ?? SELECT_EMPTY_VALUE) ||
    settingsForm.announcementSourceInterfaceId !==
      (s.announcement_source?.id ?? SELECT_EMPTY_VALUE) ||
    settingsForm.priceBackfillSourceInterfaceId !==
      (s.price_backfill_source?.id ?? SELECT_EMPTY_VALUE) ||
    // 每日回补额度：服务端 null 时按后端默认 1000 兜底，与 watch 回填口径一致
    settingsForm.priceBackfillQuota !==
      (s.price_backfill_quota != null ? String(s.price_backfill_quota) : '1000') ||
    // 回补起始日期配置默认值：服务端 null 时回退一年前，与 watch 回填口径一致
    settingsForm.priceBackfillStartDate !==
      (s.price_backfill_default_start_date ?? oneYearAgoIso()) ||
    // 回补模式：与 watch 回填同口径（空值兜底 legacy）
    settingsForm.priceBackfillMode !==
      (s.price_backfill_mode || PRICE_BACKFILL_MODE_LEGACY) ||
    // 回补复权方式：与 watch 回填同口径（空值兜底不复权）
    settingsForm.priceBackfillAdjust !==
      (s.price_backfill_adjust ?? PRICE_BACKFILL_ADJUST_NONE) ||
    // 交易日历刷新起始日期：服务端 null → 空串，与 watch 回填口径一致
    settingsForm.tradeCalendarStartDate !== (s.trade_calendar_start_date ?? '')
  );
});

/** 保存全局设置（百分数 → 小数比率；覆盖两个 TAB 的全部字段） */
function handleSaveSettings(): void {
  const err = validateSettings();
  if (err) {
    settingsFormError.value = err;
    return;
  }
  settingsFormError.value = '';
  const q = quotaToValue(settingsForm.priceBackfillQuota);
  const payload: UpdateDividendYieldSettingsDto = {
    green_threshold: percentToRatio(settingsForm.greenPercent).ratio,
    red_threshold: percentToRatio(settingsForm.redPercent).ratio,
    dividend_report_source_interface_id: toInterfaceIdOrNull(
      settingsForm.dividendReportSourceInterfaceId,
    ),
    dividend_detail_source_interface_id: toInterfaceIdOrNull(
      settingsForm.dividendDetailSourceInterfaceId,
    ),
    price_source_interface_id: toInterfaceIdOrNull(
      settingsForm.priceSourceInterfaceId,
    ),
    announcement_source_interface_id: toInterfaceIdOrNull(
      settingsForm.announcementSourceInterfaceId,
    ),
    price_backfill_source_interface_id: toInterfaceIdOrNull(
      settingsForm.priceBackfillSourceInterfaceId,
    ),
    // 每日回补额度：空串 → null（用后端默认）；合法整数直接传
    price_backfill_quota: q.value,
    // 回补起始日期配置默认值：与在途标记解耦，随设置保存；空串 → null（用既有值）
    price_backfill_default_start_date: settingsForm.priceBackfillStartDate
      ? settingsForm.priceBackfillStartDate
      : null,
    // 回补模式：'legacy' | 'gap'，后端有值域校验（越界 400）；下拉只给两项，无需前端再校验
    price_backfill_mode: settingsForm.priceBackfillMode,
    // 回补复权方式：'' | 'qfq' | 'hfq'，后端有值域校验（越界 400）；下拉只给三项，无需前端再校验
    price_backfill_adjust: settingsForm.priceBackfillAdjust,
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
        <!-- 初始化 TAB：冷启动 / 数据修复（回补接口、额度、起点、模式、复权方式 + 手工动作按钮） -->
        <Card v-if="active === 'init'">
          <CardHeader>
            <CardTitle class="text-base">初始化</CardTitle>
            <CardDescription>
              冷启动 / 数据修复用的配置与手工动作；触发后任务在后台执行，进度见应用日志。
            </CardDescription>
          </CardHeader>
          <CardContent class="space-y-6">
            <GlobalSettingsDividendInitSection
              v-model:interface-id="settingsForm.priceBackfillSourceInterfaceId"
              v-model:quota="settingsForm.priceBackfillQuota"
              v-model:default-start-date="settingsForm.priceBackfillStartDate"
              v-model:mode="settingsForm.priceBackfillMode"
              v-model:adjust="settingsForm.priceBackfillAdjust"
              v-model:trade-calendar-start-date="settingsForm.tradeCalendarStartDate"
              :interface-options="priceBackfillInterfaceOptions"
              :in-flight-start-date="dividendSettings?.price_backfill_start_date ?? null"
              :used-today="dividendSettings?.price_backfill_used_today ?? 0"
              :last-error="dividendSettings?.price_backfill_last_error ?? null"
            />
          </CardContent>
        </Card>

        <!-- 股息率 TAB：阈值 + 四源接口 -->
        <GlobalSettingsDividendTab
          v-else
          v-model:green-percent="settingsForm.greenPercent"
          v-model:red-percent="settingsForm.redPercent"
          v-model:dividend-report-source-interface-id="
            settingsForm.dividendReportSourceInterfaceId
          "
          v-model:dividend-detail-source-interface-id="
            settingsForm.dividendDetailSourceInterfaceId
          "
          v-model:price-source-interface-id="settingsForm.priceSourceInterfaceId"
          v-model:announcement-source-interface-id="
            settingsForm.announcementSourceInterfaceId
          "
          :dividend-source-options="dividendSourceOptions"
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
