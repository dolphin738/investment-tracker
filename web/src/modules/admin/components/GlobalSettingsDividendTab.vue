<script setup lang="ts">
/**
 * modules/admin/components/GlobalSettingsDividendTab.vue — 全局设置页「股息率」TAB 内容
 *
 * 哑组件（presentational）：不取数、不管保存、不持有状态；settingsForm 与读写逻辑已上移至
 * 父级 GlobalSettingsPage（两个 TAB 共享同一份 state，避免各自 PUT 全字段互相覆盖）。
 * 本组件仅接 props 渲染、用 emit 回传值。
 *
 * 注：股息率标色阈值已迁至「个人中心 → 偏好设置」（随账号存储，见 0026 迁移），
 * 本 TAB 只剩四源接口配置。
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

/** 分红留存年数合法区间（与后端 settings_router 的 RETENTION_YEARS_MIN/MAX 一致） */
const RETENTION_MIN = 1;
const RETENTION_MAX = 10;

/** 接口候选项形状（与父级 listAllInterfaces 过滤结果一致） */
interface InterfaceOption {
  id: string;
  provider_id: string;
  name: string;
}

defineProps<{
  /** 股息明细源接口 id（含哨兵值） */
  dividendDetailSourceInterfaceId: string;
  /** 行情源接口 id（含哨兵值） */
  priceSourceInterfaceId: string;
  /** 公司公告接口 id（含哨兵值） */
  announcementSourceInterfaceId: string;
  /** 分红留存窗年数（1~10，默认 5）：采集窗与留存清理窗共用 */
  dividendRetentionYears: number;
  /** 股息明细源接口候选（category_id === '3' && enabled） */
  dividendDetailOptions: InterfaceOption[];
  /** 行情源候选（category_id === '2' && enabled） */
  priceSourceOptions: InterfaceOption[];
  /** 公司公告接口候选（category_id === '4' && enabled） */
  announcementSourceOptions: InterfaceOption[];
  /** 提供方 id → 名称（用于「接口名（提供方名）」拼接） */
  providerNameById: Map<string, string>;
}>();

const emit = defineEmits<{
  (e: 'update:dividendDetailSourceInterfaceId', v: string): void;
  (e: 'update:priceSourceInterfaceId', v: string): void;
  (e: 'update:announcementSourceInterfaceId', v: string): void;
  (e: 'update:dividendRetentionYears', v: number): void;
}>();

/**
 * 留存年数输入：number input 的 model-value 是 string，须转数字并夹到合法区间。
 * 非法（空串 / NaN）不回传——保持表单原值，避免把 NaN 写进 payload 触发后端 400。
 */
function onRetentionYearsInput(v: unknown): void {
  const n = Number(v);
  if (!Number.isFinite(n)) return;
  const clamped = Math.min(RETENTION_MAX, Math.max(RETENTION_MIN, Math.round(n)));
  emit('update:dividendRetentionYears', clamped);
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">股息率</CardTitle>
      <CardDescription>
        股息率榜单的数据源接口配置（标色阈值已迁「个人中心 → 偏好设置」，随账号存储）
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-6">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <!-- 股息明细源接口 -->
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

        <!-- 公司公告接口 -->
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

        <!-- 分红留存年数（D-4）：采集窗与留存清理窗共用同一配置 -->
        <div class="space-y-2">
          <Label for="dy-retention-years">分红留存年数</Label>
          <Input
            id="dy-retention-years"
            :model-value="String(dividendRetentionYears)"
            type="number"
            :min="RETENTION_MIN"
            :max="RETENTION_MAX"
            step="1"
            class="w-full"
            @update:model-value="onRetentionYearsInput"
          />
          <p class="text-xs text-muted-foreground">
            保留最近 N 个财年（{{ RETENTION_MIN }}~{{ RETENTION_MAX }}，默认 5）。
            分红采集窗口与留存清理窗口共用此值，二者始终对齐。
          </p>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
