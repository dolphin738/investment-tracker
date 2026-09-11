<script setup lang="ts">
/**
 * modules/admin/components/InterfaceResponseParseFields.vue — 响应解析页签内容
 *
 * 从 QuoteInterfaceDialog.vue 抽出（行数治理）：非 JSON 文本源（如腾讯财经 ~ 分隔）
 * 的解析协议配置。form 为父级 reactive 表单对象，经 v-model 直接读写 rp* 字段。
 */
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { FormState } from '../utils/quote-interface-form';

/** 响应解析协议格式（json 默认 / text_split 非 JSON 文本分隔） */
const RP_FORMAT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'json', label: 'JSON（默认）' },
  { value: 'text_split', label: '文本分隔（如腾讯财经 ~）' },
];

defineProps<{ form: FormState }>();
</script>

<template>
  <div class="space-y-3">
    <div class="space-y-2">
      <Label for="qi-rp-format">响应格式</Label>
      <Select v-model="form.rpFormat">
        <SelectTrigger id="qi-rp-format">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="o in RP_FORMAT_OPTIONS" :key="o.value" :value="o.value">
            {{ o.label }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <template v-if="form.rpFormat === 'text_split'">
      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-2">
          <Label for="qi-rp-encoding">编码</Label>
          <Input
            id="qi-rp-encoding"
            v-model="form.rpEncoding"
            placeholder="utf-8（腾讯财经填 gbk）"
          />
        </div>
        <div class="space-y-2">
          <Label for="qi-rp-sep">分隔符</Label>
          <Input id="qi-rp-sep" v-model="form.rpSep" placeholder="~" />
        </div>
      </div>
      <div class="space-y-2">
        <Label for="qi-rp-line-regex">行提取正则</Label>
        <Input
          id="qi-rp-line-regex"
          v-model="form.rpLineRegex"
          placeholder='v_(\w+)="([^"]*)"'
        />
      </div>
      <div class="space-y-2">
        <Label for="qi-rp-code-param">代码参数名</Label>
        <Input
          id="qi-rp-code-param"
          v-model="form.rpCodeParam"
          placeholder="code（腾讯财经填 q）"
        />
      </div>
    </template>

    <div class="space-y-2">
      <Label for="qi-rp-code-prefix">代码前缀补全</Label>
      <Select
        :model-value="form.rpCodePrefix || 'none'"
        @update:model-value="
          (v: string) => (form.rpCodePrefix = v === 'none' ? '' : v)
        "
      >
        <SelectTrigger id="qi-rp-code-prefix">
          <SelectValue placeholder="原样（不补全）" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">原样（不补全）</SelectItem>
          <SelectItem value="auto">
            自动补交易所前缀（覆盖 A股/场内基金/港股）
          </SelectItem>
        </SelectContent>
      </Select>
      <p class="text-xs text-muted-foreground">
        选「自动」后，位数感知补全：5 位纯数字补 hk（港股，00700→hk00700）；
        6 位纯数字按首位推断 sh/sz/bj 裸拼（A股/场内基金，如 600519→sh600519、
        000001→sz000001、510300→sh510300，腾讯/新浪风格）；
        已带前缀（sh600519/hk00700）或非数字（AAPL）原样发送，绝不重复加字母。
        东方财富等直接吃纯数字代码的接口保持「原样」即可。
      </p>
    </div>

    <p class="text-xs text-muted-foreground">
      响应格式选「文本分隔」时，按 sep 拆分每行、按 line_regex 提取带前缀代码（group1）与内容（group2）；
      代码前缀（sh/sz/hk/us）会被保留用于归一化。编码默认 utf-8（腾讯财经需 gbk），
      代码参数名默认 code（腾讯财经为 q，且调用路径请以 <code class="font-mono">q=</code> 结尾以走内联形态）。
    </p>
  </div>
</template>
