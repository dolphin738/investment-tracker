<script setup lang="ts">
/**
 * modules/admin/components/InterfaceAdvancedSettings.vue — 高级设置页签内容
 *
 * 从 QuoteInterfaceDialog.vue 抽出（行数治理）：参数模板（键值对增删）、描述、
 * 超时 / 重试 / 频率限制。form 为父级 reactive 表单对象，经 v-model 直接读写。
 */
import { Plus, Trash2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { FormState } from '../utils/quote-interface-form';

const props = defineProps<{ form: FormState }>();

function addParamRow(): void {
  props.form.params.push({ key: '', value: '' });
}
function removeParamRow(idx: number): void {
  props.form.params.splice(idx, 1);
}
</script>

<template>
  <div class="space-y-4">
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <Label for="qi-params">参数模板</Label>
        <Button variant="ghost" size="sm" @click="addParamRow">
          <Plus class="mr-1 h-3.5 w-3.5" /> 添加参数
        </Button>
      </div>
      <p v-if="form.params.length === 0" class="text-xs text-muted-foreground">
        暂无可编辑参数，点击「添加参数」新增键值对（如 type / region）
      </p>
      <div class="space-y-2">
        <div
          v-for="(row, idx) in form.params"
          :key="idx"
          class="flex items-center gap-2"
        >
          <Input class="w-2/5" v-model="row.key" placeholder="参数名" />
          <Input class="flex-1" v-model="row.value" placeholder="参数值" />
          <Button
            variant="ghost"
            size="icon"
            aria-label="删除参数"
            @click="removeParamRow(idx)"
          >
            <Trash2 class="h-4 w-4" />
          </Button>
        </div>
      </div>
      <p class="text-xs text-muted-foreground">
        这些参数会作为查询条件随每次调用发送（如 iTick 的 <code class="font-mono">type</code>{' '}
        / <code class="font-mono">region</code>）；空值参数在请求时自动忽略。
      </p>
    </div>

    <div class="space-y-2">
      <Label for="qi-desc">描述</Label>
      <Textarea
        id="qi-desc"
        v-model="form.description"
        placeholder="可选，备注该接口用途"
        :rows="3"
      />
    </div>

    <div class="grid grid-cols-3 gap-4">
      <div class="space-y-2">
        <Label for="qi-timeout">超时(秒)</Label>
        <Input
          id="qi-timeout"
          v-model="form.timeout"
          type="number"
          placeholder="可选"
        />
      </div>
      <div class="space-y-2">
        <Label for="qi-retry">重试次数</Label>
        <Input
          id="qi-retry"
          v-model="form.retryCount"
          type="number"
          placeholder="可选"
        />
      </div>
      <div class="space-y-2">
        <Label for="qi-rate">频率限制</Label>
        <Input
          id="qi-rate"
          v-model="form.rateLimit"
          placeholder="如 100/min"
        />
      </div>
    </div>
  </div>
</template>
