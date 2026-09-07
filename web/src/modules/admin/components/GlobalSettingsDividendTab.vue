<script setup lang="ts">
/**
 * modules/admin/components/GlobalSettingsDividendTab.vue — 全局设置页「股息率」TAB 内容
 * （方案 §10.4：股息率设置整体从设置页迁出，本组件承载全部股息率配置逻辑；
 * 原 PrefsDividendTab 迁移而来，并新增「公司公告接口」可配置项 §5.4）
 *
 * 阈值 + 主数据源/明细源 + 行情源 + 公司公告源接口配置；admin-only（由父级页面 v-if 保证，
 * 后端仍 403 兜底）。P2-8：UI 用百分数展示（如 5 = 5%），提交时转换为小数比率（§2.4）。
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2 } from 'lucide-vue-next';
import {
  useDividendYieldInterfaces,
  useDividendYieldSettings,
  useUpdateDividendYieldSettings,
} from '@/modules/dividend-yield/composables/use-dividend-yield';
import { useQuoteProviders } from '@/modules/admin/composables/use-quote-provider';
import type { UpdateDividendYieldSettingsDto } from '@/api/types';

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

// 提供方 id → 名称：四个源下拉展示接口归属（如「东财-分红配送（东方财富）」）
const { data: providers } = useQuoteProviders();
const providerNameById = computed(() => {
  const m = new Map<string, string>();
  (providers.value ?? []).forEach((p) => m.set(p.id, p.name));
  return m;
});

// 股息率设置本地表单：阈值以**百分数**存储（5 = 5%），提交时转小数（P2-8 / §2.4）
const settingsForm = reactive({
  greenPercent: '',
  redPercent: '',
  dividendReportSourceInterfaceId: '',
  dividendDetailSourceInterfaceId: '',
  priceSourceInterfaceId: '',
  announcementSourceInterfaceId: '',
});
const settingsFormError = ref('');

/** 小数比率 → 百分数字符串（0.05 → "5"） */
function ratioToPercent(v: number | null): string {
  return v != null ? String(Number((v * 100).toFixed(4))) : '';
}

watch(dividendSettings, (s) => {
  if (!s) return;
  settingsForm.greenPercent = ratioToPercent(s.green_threshold);
  settingsForm.redPercent = ratioToPercent(s.red_threshold);
  settingsForm.dividendReportSourceInterfaceId = s.dividend_report_source?.id ?? '';
  settingsForm.dividendDetailSourceInterfaceId = s.dividend_detail_source?.id ?? '';
  settingsForm.priceSourceInterfaceId = s.price_source?.id ?? '';
  settingsForm.announcementSourceInterfaceId = s.announcement_source?.id ?? '';
});

/** 百分数字符串 → 小数比率 / null（空串视为 null；非法输入返回 undefined 触发校验错误） */
function percentToRatio(v: string): { ratio: number | null; invalid: boolean } {
  const t = v.trim();
  if (t === '') return { ratio: null, invalid: false };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ratio: null, invalid: true };
  return { ratio: n / 100, invalid: false };
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
  return null;
}

/** 股息率设置是否有本地变更（与服务端对比，阈值按百分数口径比较） */
const settingsHasChanges = computed(() => {
  const s = dividendSettings.value;
  if (!s) return false;
  return (
    settingsForm.greenPercent !== ratioToPercent(s.green_threshold) ||
    settingsForm.redPercent !== ratioToPercent(s.red_threshold) ||
    settingsForm.dividendReportSourceInterfaceId !==
      (s.dividend_report_source?.id ?? '') ||
    settingsForm.dividendDetailSourceInterfaceId !==
      (s.dividend_detail_source?.id ?? '') ||
    settingsForm.priceSourceInterfaceId !== (s.price_source?.id ?? '') ||
    settingsForm.announcementSourceInterfaceId !==
      (s.announcement_source?.id ?? '')
  );
});

/** 保存股息率设置（百分数 → 小数比率） */
function handleSaveSettings(): void {
  const err = validateSettings();
  if (err) {
    settingsFormError.value = err;
    return;
  }
  settingsFormError.value = '';
  const payload: UpdateDividendYieldSettingsDto = {
    green_threshold: percentToRatio(settingsForm.greenPercent).ratio,
    red_threshold: percentToRatio(settingsForm.redPercent).ratio,
    dividend_report_source_interface_id:
      settingsForm.dividendReportSourceInterfaceId || null,
    dividend_detail_source_interface_id:
      settingsForm.dividendDetailSourceInterfaceId || null,
    price_source_interface_id: settingsForm.priceSourceInterfaceId || null,
    announcement_source_interface_id:
      settingsForm.announcementSourceInterfaceId || null,
  };
  settingsMutation.mutate(payload);
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">股息率</CardTitle>
      <CardDescription>
        股息率榜单的标色阈值与数据源接口配置；标色按 A 股语义：≥ 绿色阈值显示红色、≤ 红色阈值显示绿色（§10.2）
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-6">
      <div v-if="settingsLoading" class="space-y-3">
        <Skeleton v-for="i in 4" :key="i" class="h-10 w-full" />
      </div>
      <template v-else>
        <!-- 股息率阈值（百分数输入，提交转小数） -->
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div class="space-y-2">
            <Label for="dy-green">绿色阈值（股息率 ≥ 显示红色）</Label>
            <div class="flex items-center gap-2">
              <Input
                id="dy-green"
                v-model="settingsForm.greenPercent"
                type="number"
                min="0"
                max="100"
                step="0.5"
                placeholder="如 5（即 5%）"
              />
              <span class="text-sm text-muted-foreground">%</span>
            </div>
          </div>
          <div class="space-y-2">
            <Label for="dy-red">红色阈值（股息率 ≤ 显示绿色）</Label>
            <div class="flex items-center gap-2">
              <Input
                id="dy-red"
                v-model="settingsForm.redPercent"
                type="number"
                min="0"
                max="100"
                step="0.5"
                placeholder="如 3（即 3%）"
              />
              <span class="text-sm text-muted-foreground">%</span>
            </div>
          </div>
        </div>
        <p class="text-xs text-muted-foreground">
          阈值以百分数输入（5 = 5%）；校验规则：0 &lt; 红色 &lt; 绿色 ≤ 100%
        </p>

        <!-- 股息主源 -->
        <div class="space-y-2">
          <Label for="dy-report-source">股息主数据源接口（按报告期全量）</Label>
          <Select v-model="settingsForm.dividendReportSourceInterfaceId">
            <SelectTrigger id="dy-report-source" class="w-full">
              <SelectValue placeholder="选择股息主数据源接口" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">不设置</SelectItem>
              <SelectItem
                v-for="itf in dividendSourceOptions"
                :key="itf.id"
                :value="itf.id"
              >
                {{ itf.name }}（{{ providerNameById.get(itf.provider_id) ?? '未知提供方' }}）
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- 股息补充源 -->
        <div class="space-y-2">
          <Label for="dy-detail-source">股息明细源接口（按证券逐只）</Label>
          <Select v-model="settingsForm.dividendDetailSourceInterfaceId">
            <SelectTrigger id="dy-detail-source" class="w-full">
              <SelectValue placeholder="选择股息明细源接口" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">不设置</SelectItem>
              <SelectItem
                v-for="itf in dividendDetailOptions"
                :key="itf.id"
                :value="itf.id"
              >
                {{ itf.name }}（{{ providerNameById.get(itf.provider_id) ?? '未知提供方' }}）
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- 行情源 -->
        <div class="space-y-2">
          <Label for="dy-price-source">行情源接口（收盘价）</Label>
          <Select v-model="settingsForm.priceSourceInterfaceId">
            <SelectTrigger id="dy-price-source" class="w-full">
              <SelectValue placeholder="选择行情源接口" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">不设置</SelectItem>
              <SelectItem
                v-for="itf in priceSourceOptions"
                :key="itf.id"
                :value="itf.id"
              >
                {{ itf.name }}（{{ providerNameById.get(itf.provider_id) ?? '未知提供方' }}）
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- 公司公告源 -->
        <div class="space-y-2">
          <Label for="dy-announcement-source">公司公告接口（特别分红扫描，§6.8）</Label>
          <Select v-model="settingsForm.announcementSourceInterfaceId">
            <SelectTrigger id="dy-announcement-source" class="w-full">
              <SelectValue placeholder="选择公司公告接口" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">不设置</SelectItem>
              <SelectItem
                v-for="itf in announcementSourceOptions"
                :key="itf.id"
                :value="itf.id"
              >
                {{ itf.name }}（{{ providerNameById.get(itf.provider_id) ?? '未知提供方' }}）
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <p v-if="settingsFormError" class="text-xs text-red-500">
          {{ settingsFormError }}
        </p>

        <!-- 保存 -->
        <div class="flex items-center gap-3 pt-2">
          <Button
            :disabled="!settingsHasChanges || settingsPending"
            @click="handleSaveSettings"
          >
            <Loader2
              v-if="settingsPending"
              class="mr-2 h-4 w-4 animate-spin"
            />
            保存股息率设置
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
    </CardContent>
  </Card>
</template>
