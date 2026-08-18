<script setup lang="ts">
/**
 * modules/portfolio/components/PortfolioDialog.vue — 创建/编辑组合对话框
 *
 * 平移自 React 版 web/src/features/portfolio/portfolio-dialog.tsx。
 * 受控组件：通过 open prop / open-change 事件控制显隐；
 * 传入 portfolio 则编辑模式，否则创建模式。
 *
 * 校验引擎由 react-hook-form + zodResolver 换为 vee-validate + zod
 * （适配器见 lib/zod-typed-schema.toTypedSchema），schema 逐字平移。
 */

import { computed, watch } from 'vue';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { Loader2 } from 'lucide-vue-next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { zodToTypedSchema } from '@/lib/zod-typed-schema';
import {
  useCreatePortfolio,
  useUpdatePortfolio,
} from '../composables/use-portfolios';
import type { Portfolio } from '@/lib/types';

const portfolioSchema = z.object({
  name: z.string().min(1, '请输入组合名称').max(50, '名称最多 50 字'),
  description: z.string().max(200, '描述最多 200 字').optional(),
});

type PortfolioFormValues = z.infer<typeof portfolioSchema>;

const props = defineProps<{
  open: boolean;
  /** 传入则编辑模式，否则创建 */
  portfolio?: Portfolio | null;
}>();

const emit = defineEmits<{
  openChange: [open: boolean];
}>();

const isEdit = computed(() => Boolean(props.portfolio));
const createMutation = useCreatePortfolio();
const updateMutation = useUpdatePortfolio();

const { handleSubmit, resetForm, defineField, errors } = useForm<PortfolioFormValues>({
  validationSchema: zodToTypedSchema(portfolioSchema),
  initialValues: { name: '', description: '' },
});

// 对齐 React Hook Form 默认 onSubmit 模式：仅在提交时校验
const [name, nameAttrs] = defineField('name', { validateOnModelUpdate: false });
const [description, descriptionAttrs] = defineField('description', {
  validateOnModelUpdate: false,
});

// 打开时按传入组合回填（对齐 React 版 useEffect 的 reset）
watch(
  () => props.open,
  (open) => {
    if (open) {
      resetForm({
        values: {
          name: props.portfolio?.name ?? '',
          description: props.portfolio?.description ?? '',
        },
      });
    }
  },
);

const onSubmit = handleSubmit(
  (values) => {
    if (isEdit.value && props.portfolio) {
      updateMutation.mutate(
        { id: props.portfolio.id, payload: values },
        { onSuccess: () => emit('openChange', false) },
      );
    } else {
      createMutation.mutate(values, {
        onSuccess: () => emit('openChange', false),
      });
    }
  },
);

const isPending = computed(
  () => createMutation.isPending.value || updateMutation.isPending.value,
);
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => emit('openChange', v)">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ isEdit ? '编辑组合' : '新建组合' }}</DialogTitle>
        <DialogDescription>
          {{ isEdit ? '修改组合的名称或描述' : '创建一个新的投资组合' }}
        </DialogDescription>
      </DialogHeader>
      <form @submit="onSubmit">
        <div class="space-y-4">
          <div class="space-y-2">
            <Label for="portfolio-name">名称</Label>
            <Input
              id="portfolio-name"
              v-model="name"
              v-bind="nameAttrs"
              placeholder="如：A股长线组合"
            />
            <p v-if="errors.name" class="text-xs text-red-500">
              {{ errors.name }}
            </p>
          </div>
          <div class="space-y-2">
            <Label for="portfolio-description">描述（可选）</Label>
            <Textarea
              id="portfolio-description"
              v-model="description"
              v-bind="descriptionAttrs"
              placeholder="组合策略、目标等"
              :rows="3"
            />
            <p v-if="errors.description" class="text-xs text-red-500">
              {{ errors.description }}
            </p>
          </div>
        </div>
        <DialogFooter class="mt-6">
          <Button
            type="button"
            variant="outline"
            :disabled="isPending"
            @click="emit('openChange', false)"
          >
            取消
          </Button>
          <Button type="submit" :disabled="isPending">
            <Loader2 v-if="isPending" class="mr-2 h-4 w-4 animate-spin" />
            {{ isEdit ? '保存' : '创建' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
