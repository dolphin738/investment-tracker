<script setup lang="ts">
/**
 * modules/settings/components/PreferencesSelectFields.vue — 偏好基础选项字段（平移自 SettingsPreferencesTab.vue）
 *
 * 纯位置拆分：默认组合 / 默认时间维度 / 默认日期范围 / 周期聚合方式 / 周起始日 / 小数位。
 *
 * 表单状态 prefForm 由门面 SettingsPreferencesTab 持有（含 immediate 回填 watch），
 * 以同一 reactive 对象经 props 下发；Select 的 string ↔ number 适配 computed 与
 * '__none__' 哨兵适配亦随字段平移，写回同一响应式对象（行为与拆分前逐字节等价）。
 * 本组件不发起任何请求、不新建数据 hook。
 */
import { computed } from 'vue';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { QUICK_RANGE_OPTIONS } from '@/modules/query/quick-range';
import { AGGREGATION_OPTIONS, GRANULARITY_OPTIONS } from '@/lib/constants';
import type { Portfolio } from '@/lib/types';
import type { UserPreference } from '@/api/types';

/** 小数位选项 */
const DECIMAL_OPTIONS = [2, 3, 4, 5, 6].map((n) => ({
  value: String(n),
  label: `${n} 位`,
}));

/** XIRR 小数位选项 */
const XIRR_DECIMAL_OPTIONS = [2, 3, 4].map((n) => ({
  value: String(n),
  label: `${n} 位`,
}));

const props = defineProps<{
  /** 偏好表单（门面 reactive 对象的切片，写回同一响应式对象） */
  prefForm: {
    defaultPortfolioId: string;
    defaultGranularity: UserPreference['defaultGranularity'];
    defaultDateRange: UserPreference['defaultDateRange'];
    aggregation: UserPreference['aggregation'];
    weekStartsOn: number;
    navDecimals: number;
    xirrDecimals: number;
  };
  /** 组合列表（默认组合下拉，仅未归档项可选中） */
  portfolios: Portfolio[];
}>();

/** Select 数值字段适配（string ↔ number） */
const navDecimalsModel = computed<string>({
  get: () => String(props.prefForm.navDecimals),
  set: (v) => {
    props.prefForm.navDecimals = Number(v);
  },
});
const xirrDecimalsModel = computed<string>({
  get: () => String(props.prefForm.xirrDecimals),
  set: (v) => {
    props.prefForm.xirrDecimals = Number(v);
  },
});

/** 周起始日 RadioGroup 适配（string ↔ number） */
const weekStartsOnModel = computed<string>({
  get: () => String(props.prefForm.weekStartsOn),
  set: (v) => {
    props.prefForm.weekStartsOn = Number(v);
  },
});

/** 默认组合 Select 适配（哨兵 '__none__' ↔ 空串） */
const defaultPortfolioIdModel = computed<string>({
  get: () => props.prefForm.defaultPortfolioId || '__none__',
  set: (v) => {
    props.prefForm.defaultPortfolioId = v === '__none__' ? '' : v;
  },
});
</script>

<template>
  <!-- 默认组合 -->
  <div class="space-y-2">
    <Label for="pref-portfolio">默认组合</Label>
    <Select v-model="defaultPortfolioIdModel">
      <SelectTrigger id="pref-portfolio" class="w-[260px]">
        <SelectValue placeholder="选择默认组合" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">不设置</SelectItem>
        <SelectItem
          v-for="p in portfolios.filter((x) => !x.archivedAt)"
          :key="p.id"
          :value="p.id"
        >
          {{ p.name }}
        </SelectItem>
      </SelectContent>
    </Select>
    <p class="text-xs text-muted-foreground">
      登录后自动选中该组合；组合本身的新建 / 编辑 / 归档 / 删除在账户页「我的组合」完成
    </p>
  </div>

  <!-- 默认时间维度 + 日期范围（并排） -->
  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
    <div class="space-y-2">
      <Label for="pref-granularity">默认时间维度</Label>
      <Select v-model="prefForm.defaultGranularity">
        <SelectTrigger id="pref-granularity" class="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="opt in GRANULARITY_OPTIONS"
            :key="opt.value"
            :value="opt.value"
          >
            {{ opt.label }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div class="space-y-2">
      <Label for="pref-daterange">默认日期范围</Label>
      <Select v-model="prefForm.defaultDateRange">
        <SelectTrigger id="pref-daterange" class="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="opt in QUICK_RANGE_OPTIONS"
            :key="opt.value"
            :value="opt.value"
          >
            {{ opt.label }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  </div>

  <!-- 聚合方式 + 周起始日（并排） -->
  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
    <div class="space-y-2">
      <Label for="pref-aggregation">周期聚合方式</Label>
      <Select v-model="prefForm.aggregation">
        <SelectTrigger id="pref-aggregation" class="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="opt in AGGREGATION_OPTIONS"
            :key="opt.value"
            :value="opt.value"
          >
            {{ opt.label }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div class="space-y-2">
      <Label>周起始日</Label>
      <RadioGroup v-model="weekStartsOnModel" orientation="horizontal">
        <RadioGroupItem value="1" label="周一" />
        <RadioGroupItem value="0" label="周日" />
      </RadioGroup>
    </div>
  </div>

  <!-- 小数位设置（并排） -->
  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
    <div class="space-y-2">
      <Label for="pref-navdec">净值小数位</Label>
      <Select v-model="navDecimalsModel">
        <SelectTrigger id="pref-navdec" class="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="opt in DECIMAL_OPTIONS"
            :key="opt.value"
            :value="opt.value"
          >
            {{ opt.label }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div class="space-y-2">
      <Label for="pref-xirrdec">XIRR 小数位</Label>
      <Select v-model="xirrDecimalsModel">
        <SelectTrigger id="pref-xirrdec" class="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="opt in XIRR_DECIMAL_OPTIONS"
            :key="opt.value"
            :value="opt.value"
          >
            {{ opt.label }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  </div>
</template>
