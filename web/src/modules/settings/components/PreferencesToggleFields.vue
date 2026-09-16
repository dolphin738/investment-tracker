<script setup lang="ts">
/**
 * modules/settings/components/PreferencesToggleFields.vue — 偏好开关/阈值字段（平移自 SettingsPreferencesTab.vue）
 *
 * 纯位置拆分：外观主题 / 软提示开关 / 金额格式 / 快照过期阈值 四块横排。
 *
 * 表单状态 prefForm 由门面 SettingsPreferencesTab 持有（含 immediate 回填 watch），
 * 以同一 reactive 对象经 props 下发；快照阈值输入钳制 onStaleInput 随字段平移，
 * 写回同一响应式对象（行为与拆分前逐字节等价）。本组件不发起任何请求、不新建数据 hook。
 */
import { Palette } from 'lucide-vue-next';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { UserPreference } from '@/api/types';

/** 主题选项 */
const THEME_OPTIONS = [
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
  { value: 'system', label: '跟随系统' },
] as const;

const props = defineProps<{
  /** 偏好表单（门面 reactive 对象的切片，写回同一响应式对象） */
  prefForm: {
    theme: UserPreference['theme'];
    staleDays: number;
    cashHintOnCashflow: boolean;
    cashHintOnTrade: boolean;
    amountThousands: boolean;
    amountAbbrev: boolean;
  };
}>();

/** 快照过期阈值输入（1~30 天数钳制） */
function onStaleInput(event: Event): void {
  const v = Number((event.target as HTMLInputElement).value);
  if (v >= 1 && v <= 30) props.prefForm.staleDays = v;
}
</script>

<template>
  <!-- 外观主题 / 软提示开关 / 金额格式 / 快照过期阈值：四块横排 -->
  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
    <!-- 外观主题 -->
    <div class="space-y-2">
      <Label class="flex items-center gap-2">
        <Palette class="h-4 w-4" />
        外观主题
      </Label>
      <RadioGroup v-model="prefForm.theme" orientation="horizontal">
        <RadioGroupItem
          v-for="opt in THEME_OPTIONS"
          :key="opt.value"
          :value="opt.value"
          :label="opt.label"
        />
      </RadioGroup>
      <p class="text-xs text-muted-foreground">
        选择「跟随系统」将根据操作系统设置自动切换
      </p>
    </div>

    <!-- 软提示开关（SET-P0-07 · §7.8 L1376） -->
    <div class="space-y-2">
      <Label>软提示开关</Label>
      <div class="flex flex-wrap items-center gap-4">
        <label
          for="pref-hint-cashflow"
          class="inline-flex cursor-pointer items-center gap-2 text-sm"
        >
          <input
            id="pref-hint-cashflow"
            v-model="prefForm.cashHintOnCashflow"
            type="checkbox"
            class="h-4 w-4 rounded border-input accent-primary"
          />
          出入金后提示
        </label>
        <label
          for="pref-hint-trade"
          class="inline-flex cursor-pointer items-center gap-2 text-sm"
        >
          <input
            id="pref-hint-trade"
            v-model="prefForm.cashHintOnTrade"
            type="checkbox"
            class="h-4 w-4 rounded border-input accent-primary"
          />
          买卖后提示
        </label>
      </div>
      <p class="text-xs text-muted-foreground">
        录入后提示同步更新现金余额（SET-P0-07）
      </p>
    </div>

    <!-- 金额格式（SET-P1-03 · §7.8 L1377） -->
    <div class="space-y-2">
      <Label>金额格式</Label>
      <div class="flex flex-wrap items-center gap-4">
        <label
          for="pref-amount-thousands"
          class="inline-flex cursor-pointer items-center gap-2 text-sm"
        >
          <input
            id="pref-amount-thousands"
            v-model="prefForm.amountThousands"
            type="checkbox"
            class="h-4 w-4 rounded border-input accent-primary"
          />
          千分位
        </label>
        <label
          for="pref-amount-abbrev"
          class="inline-flex cursor-pointer items-center gap-2 text-sm"
        >
          <input
            id="pref-amount-abbrev"
            v-model="prefForm.amountAbbrev"
            type="checkbox"
            class="h-4 w-4 rounded border-input accent-primary"
          />
          万 / 亿缩写
        </label>
      </div>
      <p class="text-xs text-muted-foreground">
        金额展示格式（SET-P1-03），已全站接入
      </p>
    </div>

    <!-- 快照过期阈值 -->
    <div class="space-y-2">
      <Label for="pref-stale">快照过期提醒阈值（天）</Label>
      <Input
        id="pref-stale"
        type="number"
        min="1"
        max="30"
        class="w-full"
        :model-value="prefForm.staleDays"
        @input="onStaleInput"
      />
      <p class="text-xs text-muted-foreground">
        资产快照超过此天数未更新时显示提醒（1~30 天）
      </p>
    </div>
  </div>
</template>
