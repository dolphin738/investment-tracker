<script setup lang="ts">
/**
 * modules/admin/components/GlobalSettingsDividendTab.vue — 全局设置页「股息率」TAB 内容
 * （方案 §10.4：股息率设置整体从设置页迁出，本组件承载股息率阈值 + 四源接口配置）
 *
 * 哑组件（presentational）：不取数、不管保存、不持有状态；settingsForm 与读写逻辑已上移至
 * 父级 GlobalSettingsPage（两个 TAB 共享同一份 state，避免各自 PUT 全字段互相覆盖）。
 * 本组件仅接 props 渲染、用 emit 回传值。
 *
 * P2-8：UI 用百分数展示（如 5 = 5%），提交时由父组件转换为小数比率（§2.4）。
 */
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SELECT_EMPTY_VALUE } from '@/lib/constants';

/** 接口候选项形状（与父级 listAllInterfaces 过滤结果一致） */
interface InterfaceOption {
  id: string;
  provider_id: string;
  name: string;
}

defineProps<{
  /** 绿色阈值（百分数字符串，如 "5" = 5%） */
  greenPercent: string;
  /** 红色阈值（百分数字符串） */
  redPercent: string;
  /** 股息主数据源接口 id（含哨兵值表示「不设置」） */
  dividendReportSourceInterfaceId: string;
  /** 股息明细源接口 id（含哨兵值） */
  dividendDetailSourceInterfaceId: string;
  /** 行情源接口 id（含哨兵值） */
  priceSourceInterfaceId: string;
  /** 公司公告接口 id（含哨兵值） */
  announcementSourceInterfaceId: string;
  /** 股息主源候选（category_id === '3' && enabled） */
  dividendSourceOptions: InterfaceOption[];
  /** 股息补充源候选（category_id === '3' && enabled） */
  dividendDetailOptions: InterfaceOption[];
  /** 行情源候选（category_id === '2' && enabled） */
  priceSourceOptions: InterfaceOption[];
  /** 公司公告源候选（category_id === '4' && enabled） */
  announcementSourceOptions: InterfaceOption[];
  /** 提供方 id → 名称（用于「接口名（提供方名）」拼接） */
  providerNameById: Map<string, string>;
}>();

const emit = defineEmits<{
  (e: 'update:greenPercent', v: string): void;
  (e: 'update:redPercent', v: string): void;
  (e: 'update:dividendReportSourceInterfaceId', v: string): void;
  (e: 'update:dividendDetailSourceInterfaceId', v: string): void;
  (e: 'update:priceSourceInterfaceId', v: string): void;
  (e: 'update:announcementSourceInterfaceId', v: string): void;
}>();
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
      <!-- 股息率阈值（百分数输入，提交转小数） -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="space-y-2">
          <Label for="dy-green">绿色阈值（股息率 ≥ 显示红色）</Label>
          <div class="flex items-center gap-2">
            <Input
              id="dy-green"
              :model-value="greenPercent"
              type="number"
              min="0"
              max="100"
              step="0.5"
              placeholder="如 5（即 5%）"
              @update:model-value="(v) => emit('update:greenPercent', String(v))"
            />
            <span class="text-sm text-muted-foreground">%</span>
          </div>
        </div>
        <div class="space-y-2">
          <Label for="dy-red">红色阈值（股息率 ≤ 显示绿色）</Label>
          <div class="flex items-center gap-2">
            <Input
              id="dy-red"
              :model-value="redPercent"
              type="number"
              min="0"
              max="100"
              step="0.5"
              placeholder="如 3（即 3%）"
              @update:model-value="(v) => emit('update:redPercent', String(v))"
            />
            <span class="text-sm text-muted-foreground">%</span>
          </div>
        </div>
      </div>
      <p class="text-xs text-muted-foreground">
        阈值以百分数输入（5 = 5%）；校验规则：0 &lt; 红色 &lt; 绿色 ≤ 100%
      </p>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <!-- 股息主源 -->
        <div class="space-y-2">
          <Label for="dy-report-source">股息主数据源接口（按报告期全量）</Label>
          <Select
            :model-value="dividendReportSourceInterfaceId"
            @update:model-value="
              (v) => emit('update:dividendReportSourceInterfaceId', String(v))
            "
          >
            <SelectTrigger id="dy-report-source" class="w-full">
              <SelectValue placeholder="选择股息主数据源接口" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="SELECT_EMPTY_VALUE">不设置</SelectItem>
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
          <Select
            :model-value="dividendDetailSourceInterfaceId"
            @update:model-value="
              (v) => emit('update:dividendDetailSourceInterfaceId', String(v))
            "
          >
            <SelectTrigger id="dy-detail-source" class="w-full">
              <SelectValue placeholder="选择股息明细源接口" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="SELECT_EMPTY_VALUE">不设置</SelectItem>
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
          <Select
            :model-value="priceSourceInterfaceId"
            @update:model-value="(v) => emit('update:priceSourceInterfaceId', String(v))"
          >
            <SelectTrigger id="dy-price-source" class="w-full">
              <SelectValue placeholder="选择行情源接口" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="SELECT_EMPTY_VALUE">不设置</SelectItem>
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
          <Label for="dy-announcement-source">公司公告接口</Label>
          <Select
            :model-value="announcementSourceInterfaceId"
            @update:model-value="
              (v) => emit('update:announcementSourceInterfaceId', String(v))
            "
          >
            <SelectTrigger id="dy-announcement-source" class="w-full">
              <SelectValue placeholder="选择公司公告接口" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="SELECT_EMPTY_VALUE">不设置</SelectItem>
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
      </div>
    </CardContent>
  </Card>
</template>
