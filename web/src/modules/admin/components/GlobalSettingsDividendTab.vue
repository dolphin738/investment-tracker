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
  /** 股息明细源接口 id（含哨兵值） */
  dividendDetailSourceInterfaceId: string;
  /** 行情源接口 id（含哨兵值） */
  priceSourceInterfaceId: string;
  /** 公司公告接口 id（含哨兵值） */
  announcementSourceInterfaceId: string;
  /** 股息明细源接口候选（category_id === '3' && enabled） */
  dividendDetailOptions: InterfaceOption[];
  /** 行情源候选（category_id === '2' && enabled） */
  priceSourceOptions: InterfaceOption[];
  /** 公司公告源候选（category_id === '4' && enabled） */
  announcementSourceOptions: InterfaceOption[];
  /** 提供方 id → 名称（用于「接口名（提供方名）」拼接） */
  providerNameById: Map<string, string>;
}>();

const emit = defineEmits<{
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
