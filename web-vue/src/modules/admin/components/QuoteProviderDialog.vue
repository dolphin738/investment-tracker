<script setup lang="ts">
/**
 * modules/admin/components/QuoteProviderDialog.vue — 数据来源（提供方）新增/编辑对话框
 *
 * 平移自 React 版 features/admin/quote-provider-dialog.tsx，行为契约一致。
 * 字段：name、access_method（Select）、base_url | sdk_name（按接入方式二选一）、
 * description、enabled（唯一开关）。
 * 全局单一活跃源（is_default/is_active）已移除（ADR-002 方案 X），提供方仅保留启用/停用开关。
 */

import { reactive, ref, watch } from 'vue';
import { Loader2 } from 'lucide-vue-next';
import { toast } from '@/composables/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  QuoteProvider,
  QuoteProviderAccessMethod,
} from '@/api/quote-provider.api';
import {
  useCreateQuoteProvider,
  useQuoteProviders,
  useUpdateQuoteProvider,
} from '../composables/use-quote-provider';

interface FormState {
  name: string;
  accessMethod: QuoteProviderAccessMethod;
  baseUrl: string;
  sdkName: string;
  description: string;
  enabled: boolean;
}

function toForm(edit: QuoteProvider | null): FormState {
  if (!edit) {
    return {
      name: '',
      accessMethod: 'https',
      baseUrl: '',
      sdkName: '',
      description: '',
      enabled: true,
    };
  }
  return {
    name: edit.name,
    accessMethod: edit.access_method,
    baseUrl: (edit.config?.base_url as string) ?? '',
    sdkName: (edit.config?.sdk_name as string) ?? '',
    description: edit.description ?? '',
    enabled: edit.enabled,
  };
}

const props = defineProps<{
  open: boolean;
  /** 传入则编辑模式，否则新增 */
  editing: QuoteProvider | null;
}>();

const emit = defineEmits<{ openChange: [open: boolean] }>();

const createMut = useCreateQuoteProvider();
const updateMut = useUpdateQuoteProvider();
const { data: providers } = useQuoteProviders();

const form = reactive<FormState>(toForm(props.editing));
const nameError = ref<string | null>(null);

// 每次打开时按传入提供方重置表单（对齐 React 版 useEffect）
watch(
  () => [props.open, props.editing] as const,
  ([open]) => {
    if (open) {
      Object.assign(form, toForm(props.editing));
      nameError.value = null;
    }
  },
  { immediate: true },
);

const pending = () => createMut.isPending.value || updateMut.isPending.value;

function handleSubmit(): void {
  const name = form.name.trim();
  if (!name) {
    toast.error('请填写名称');
    return;
  }
  // 名称唯一性：创建时与任一现有提供方重名、编辑时与「其它」提供方重名均拦截
  const dupName = (providers.value ?? []).find(
    (p) =>
      p.name.trim().toLowerCase() === name.toLowerCase() &&
      p.id !== props.editing?.id,
  );
  if (dupName) {
    nameError.value = '已存在同名数据来源，请更换名称';
    return;
  }
  if (form.accessMethod === 'https' && !form.baseUrl.trim()) {
    toast.error('HTTPS 接入方式必须填写 API 基础地址');
    return;
  }
  if (form.accessMethod === 'sdk' && !form.sdkName.trim()) {
    toast.error('SDK 接入方式必须填写 SDK 名称');
    return;
  }
  const config =
    form.accessMethod === 'https'
      ? { base_url: form.baseUrl.trim() }
      : { sdk_name: form.sdkName.trim() };
  const payload = {
    name,
    access_method: form.accessMethod,
    config,
    enabled: form.enabled,
    description: form.description.trim() || null,
  };
  if (props.editing) {
    updateMut.mutate(
      { id: props.editing.id, body: payload },
      { onSuccess: () => emit('openChange', false) },
    );
  } else {
    createMut.mutate(payload, { onSuccess: () => emit('openChange', false) });
  }
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => emit('openChange', v)">
    <DialogContent class="max-w-xl">
      <DialogHeader>
        <DialogTitle>{{ props.editing ? '编辑数据来源' : '新增数据来源' }}</DialogTitle>
        <DialogDescription>
          {{ props.editing ? '修改该数据来源的配置' : '新增一个行情数据来源（提供方）' }}
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <div class="space-y-2">
          <Label for="qp-name">名称</Label>
          <Input
            id="qp-name"
            v-model="form.name"
            placeholder="如 新浪财经"
            :aria-invalid="nameError ? true : undefined"
            @update:model-value="nameError = null"
          />
          <p v-if="nameError" class="text-xs text-red-500">{{ nameError }}</p>
        </div>

        <div class="space-y-2">
          <Label for="qp-access-method">接入方式</Label>
          <Select v-model="form.accessMethod">
            <SelectTrigger id="qp-access-method">
              <SelectValue placeholder="选择接入方式" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="https">HTTPS（API 地址）</SelectItem>
              <SelectItem value="sdk">SDK（如 akshare）</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div v-if="form.accessMethod === 'https'" class="space-y-2">
          <Label for="qp-base-url">API 基础地址</Label>
          <Input
            id="qp-base-url"
            v-model="form.baseUrl"
            placeholder="https://example.com/api"
          />
        </div>
        <div v-else class="space-y-2">
          <Label for="qp-sdk-name">SDK 名称</Label>
          <Input id="qp-sdk-name" v-model="form.sdkName" placeholder="如 akshare" />
        </div>

        <div class="space-y-2">
          <Label for="qp-desc">描述</Label>
          <Textarea
            id="qp-desc"
            v-model="form.description"
            placeholder="可选，备注该数据来源用途"
            :rows="3"
          />
        </div>

        <div class="flex items-center justify-between rounded-md border p-3">
          <div class="space-y-0.5">
            <Label for="qp-enabled" class="text-sm">启用</Label>
            <p class="text-xs text-muted-foreground">
              禁用的提供方不参与行情解析（仍可被重新启用）
            </p>
          </div>
          <Switch id="qp-enabled" v-model="form.enabled" />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('openChange', false)">取消</Button>
        <Button :disabled="pending()" @click="handleSubmit">
          <Loader2 v-if="pending()" class="mr-2 h-4 w-4 animate-spin" />
          保存
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>