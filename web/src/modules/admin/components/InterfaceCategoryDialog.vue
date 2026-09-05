<script setup lang="ts">
/**
 * modules/admin/components/InterfaceCategoryDialog.vue — 接口分类新增/编辑对话框
 *
 * 平移自 React 版 features/admin/interface-category-dialog.tsx，行为契约一致。
 * editing 为 null 时为新增模式（提交调 create），传入分类则为编辑模式（提交调 update）。
 * 字段：label、icon（lucide 图标名）、sort_order。
 * label 重复时后端允许（UI 自行去重展示），此处不二次提示。
 */

import { computed, reactive, watch } from 'vue';
import { Loader2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { InterfaceCategory } from '@/api/interface-category.api';
import {
  useCreateInterfaceCategory,
  useUpdateInterfaceCategory,
} from '../composables/use-interface-category';

interface FormState {
  label: string;
  icon: string;
  sortOrder: string;
}

function toForm(edit: InterfaceCategory | null): FormState {
  if (!edit) {
    return { label: '', icon: '', sortOrder: '0' };
  }
  return {
    label: edit.label,
    icon: edit.icon ?? '',
    sortOrder: String(edit.sort_order),
  };
}

const props = defineProps<{
  open: boolean;
  /** 传入则编辑模式；null 为新增模式 */
  editing: InterfaceCategory | null;
}>();

const emit = defineEmits<{ openChange: [open: boolean] }>();

/** 新增模式：未传入编辑对象 */
const isCreate = computed(() => props.editing === null);

const createMut = useCreateInterfaceCategory();
const updateMut = useUpdateInterfaceCategory();
const form = reactive<FormState>(toForm(props.editing));

// 提交中状态：新增 / 编辑任一 pending 即禁用提交按钮
const submitting = computed(
  () => createMut.isPending.value || updateMut.isPending.value,
);

// 打开时按传入分类重置表单
watch(
  () => [props.open, props.editing] as const,
  ([open]) => {
    if (open) Object.assign(form, toForm(props.editing));
  },
  { immediate: true },
);

function handleSubmit(): void {
  if (!form.label.trim()) {
    return;
  }
  const payload = {
    label: form.label.trim(),
    icon: form.icon.trim() || null,
    sort_order: form.sortOrder.trim() ? Number(form.sortOrder) : 0,
  };
  if (props.editing) {
    updateMut.mutate(
      { id: props.editing.id, body: payload },
      { onSuccess: () => emit('openChange', false) },
    );
  } else {
    createMut.mutate(payload, {
      onSuccess: () => emit('openChange', false),
    });
  }
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => emit('openChange', v)">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>{{ isCreate ? '新增分类' : '编辑分类' }}</DialogTitle>
        <DialogDescription>
          {{ isCreate ? '新增接口分类' : '修改接口分类' }}
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <div class="space-y-2">
          <Label for="cat-label">展示名</Label>
          <Input id="cat-label" v-model="form.label" placeholder="如 A股列表" />
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div class="space-y-2">
            <Label for="cat-icon">图标（lucide 名）</Label>
            <Input id="cat-icon" v-model="form.icon" placeholder="如 List" />
          </div>
          <div class="space-y-2">
            <Label for="cat-order">排序</Label>
            <Input id="cat-order" v-model="form.sortOrder" type="number" />
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('openChange', false)">取消</Button>
        <Button :disabled="submitting" @click="handleSubmit">
          <Loader2 v-if="submitting" class="mr-2 h-4 w-4 animate-spin" />
          {{ isCreate ? '新增' : '保存' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
