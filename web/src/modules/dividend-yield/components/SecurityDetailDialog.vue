<script setup lang="ts">
/**
 * modules/dividend-yield/components/SecurityDetailDialog.vue — 证券详情弹窗
 *
 * RankingPage 行点击后弹出（TopPage 仍为行下展开面板，二者共用 SecurityDetailPanel）：
 * - 包装 SecurityDetailPanel（近一年股息率曲线 + 目标收益率反推隐含价格）为模态弹窗；
 * - security 为 null 时弹窗关闭且内部面板不挂载：曲线 / 隐含价格查询随组件销毁，
 *   每次点击行都重新挂载加载 → 弹窗数据始终与所点行对应；
 * - 关闭途径（右上角 X / 遮罩 / Esc / 面板内「关闭」按钮）统一经 update:open 回抛，
 *   由父页面清空选中行，返回榜单列表状态；
 * - 响应式与移动端适配：移动端左右各留 1rem（w-[calc(100vw-2rem)]）、内边距缩减，
 *   sm 起最大宽 2xl；高度上限 85dvh，内容超出时弹窗内部滚动；曲线随容器 autoresize。
 */
import { computed } from 'vue';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import SecurityDetailPanel from './SecurityDetailPanel.vue';

const props = defineProps<{
  /** 当前选中行（null = 弹窗关闭）；数据契约与 SecurityDetailPanel 一致 */
  security: { master_id: string; code: string | null; name: string | null } | null;
}>();

const emit = defineEmits<{ 'update:open': [open: boolean] }>();

/** open 派生自 security 非空；关闭动作只允许经 update:open 回抛父页面清空 */
const open = computed<boolean>({
  get: () => props.security != null,
  set: (v) => {
    if (!v) emit('update:open', false);
  },
});

function handleClose(): void {
  emit('update:open', false);
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="max-h-[85dvh] w-[calc(100vw-2rem)] overflow-y-auto p-4 sm:max-w-2xl sm:p-6"
    >
      <!-- 无障碍：视觉标题由内嵌面板 CardTitle 承担，此处 sr-only 满足 reka-ui 契约 -->
      <DialogTitle class="sr-only">
        {{ security?.name || security?.code || '证券' }} 股息率详情
      </DialogTitle>
      <DialogDescription class="sr-only">
        近一年股息率曲线与目标收益率反推隐含价格
      </DialogDescription>
      <SecurityDetailPanel v-if="security" :security="security" @close="handleClose" />
    </DialogContent>
  </Dialog>
</template>
