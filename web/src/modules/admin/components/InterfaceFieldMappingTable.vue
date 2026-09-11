<script setup lang="ts">
/**
 * modules/admin/components/InterfaceFieldMappingTable.vue — 字段映射可增删行表格
 *
 * 从 QuoteInterfaceDialog 的「字段映射」页签抽出（方案 §7）：
 * - slot 下拉 / 类型 / 单位选项全部来自契约端点 schema（不硬编码白名单）
 * - 表头按 contracts[categoryId].required 给必需槽位打 *（无 slot 的展示字段不打）
 * - source 输入框旁实时校验（前端路径解析器，与后端语义一致，见 utils/response-fields）
 * - 「高级」展开区承载 key（逻辑名）/ 单位 / 小数位 / 日期格式
 *
 * 行数据与 schema 均由 props 传入；增删改通过 emit 交回父级（行对象不在此处持有）。
 */
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ResponseFieldSchema } from '@/api/quote-interface.api';
import {
  parseSourcePath,
  slotLabelWithContract,
  type FieldMappingRow,
} from '../utils/response-fields';

/** slot 下拉的「仅展示」哨兵值（reka-ui 不接受空字符串 value） */
const DISPLAY_ONLY = '__display__';

const props = defineProps<{
  rows: FieldMappingRow[];
  /** 契约端点载荷（slot / 类型 / 单位 / 按分类契约）；null = 加载中或非管理员 */
  schema: ResponseFieldSchema | null;
  /** 当前接口分类 id（用于契约必填标记） */
  categoryId: string;
}>();

const emit = defineEmits<{
  addRow: [];
  removeRow: [idx: number];
  updateRow: [idx: number, patch: Partial<FieldMappingRow>];
}>();

/** 当前分类的契约必填 slot 列表（无契约分类返回空数组） */
function contractRequiredSlots(): string[] {
  const contract = props.schema?.contracts?.[String(props.categoryId)];
  return contract?.required ?? [];
}

/** slot 下拉展示文案（契约必填槽位加 * 后缀） */
function slotOptionLabel(value: string, label: string): string {
  return slotLabelWithContract(value, label, contractRequiredSlots());
}

/** 单行 source 实时校验结果（与后端 parse_source 同语义） */
function sourceCheck(source: string) {
  return parseSourcePath(source);
}

/** slot 值 ↔ 哨兵互转（空串 = 仅展示） */
function slotToValue(slot: string): string {
  return slot ? slot : DISPLAY_ONLY;
}
function valueToSlot(value: string): string {
  return value === DISPLAY_ONLY ? '' : value;
}

function patchSlot(idx: number, value: string): void {
  emit('updateRow', idx, { slot: valueToSlot(value) });
}
function patchType(idx: number, value: string): void {
  // 类型切走 decimal / date 时清掉专属高级项，避免残留非法 payload
  const patch: Partial<FieldMappingRow> = { type: value };
  if (value !== 'decimal') patch.scale = '';
  if (value !== 'date') patch.dateFormat = '';
  emit('updateRow', idx, patch);
}
function patchUnit(idx: number, value: string): void {
  emit('updateRow', idx, { unit: value });
}
function toggleAdvanced(idx: number, row: FieldMappingRow): void {
  emit('updateRow', idx, { advancedOpen: !row.advancedOpen });
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <p class="text-xs text-muted-foreground">
        映射表的语义槽位（slot）决定该字段参与哪些同步消费；不留槽位 = 仅展示
      </p>
      <Button variant="ghost" size="sm" @click="emit('addRow')">
        <Plus class="mr-1 h-3.5 w-3.5" /> 添加字段
      </Button>
    </div>

    <p v-if="props.rows.length === 0" class="text-xs text-muted-foreground">
      暂无字段映射，点击「添加字段」新增，或在试调后使用「一键预填」生成
    </p>

    <div
      v-if="props.rows.length > 0"
      class="overflow-hidden rounded-md border text-sm"
    >
      <!-- 表头：契约必填的语义槽位打 *（仅展示字段不打，方案 §5.2） -->
      <div
        class="grid items-center gap-2 border-b bg-muted/40 px-2 py-1.5 text-xs font-medium text-muted-foreground"
        style="grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.1fr) minmax(0, 1.5fr) minmax(0, 0.8fr) auto auto auto"
      >
        <span>展示名</span>
        <span>语义槽位<template v-if="contractRequiredSlots().length > 0">（<span class="text-destructive">*</span> 为当前分类必填）</template></span>
        <span>source 路径</span>
        <span>类型</span>
        <span>必填</span>
        <span>高级</span>
        <span class="w-8 text-center">删除</span>
      </div>

      <div
        v-for="(row, idx) in props.rows"
        :key="idx"
        class="border-b px-2 py-2 last:border-b-0"
      >
        <div
          class="grid items-start gap-2"
          style="grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.1fr) minmax(0, 1.5fr) minmax(0, 0.8fr) auto auto auto"
        >
          <Input
            :model-value="row.label"
            placeholder="展示名（如 证券代码）"
            @update:model-value="emit('updateRow', idx, { label: String($event ?? '') })"
          />
          <Select
            :model-value="slotToValue(row.slot)"
            :disabled="!props.schema"
            @update:model-value="(v: string) => patchSlot(idx, v)"
          >
            <SelectTrigger class="w-full">
              <SelectValue :placeholder="props.schema ? '仅展示' : '加载契约中…'" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="DISPLAY_ONLY">仅展示</SelectItem>
              <SelectItem
                v-for="opt in props.schema?.slots ?? []"
                :key="opt.value"
                :value="opt.value"
              >
                {{ slotOptionLabel(opt.value, opt.label) }}
              </SelectItem>
            </SelectContent>
          </Select>
          <div class="min-w-0">
            <Input
              :model-value="row.source"
              placeholder="取值路径：code / 0 / a.b / items[0].code / a\.b"
              class="font-mono"
              @update:model-value="emit('updateRow', idx, { source: String($event ?? '') })"
            />
            <p
              v-if="sourceCheck(row.source).status !== 'ok'"
              class="mt-0.5 text-xs"
              :class="sourceCheck(row.source).status === 'invalid' ? 'text-destructive' : 'text-muted-foreground'"
            >
              {{ sourceCheck(row.source).message }}
            </p>
          </div>
          <Select
            :model-value="row.type || 'string'"
            :disabled="!props.schema"
            @update:model-value="(v: string) => patchType(idx, v)"
          >
            <SelectTrigger class="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="t in props.schema?.types ?? []"
                :key="t"
                :value="t"
              >
                {{ t }}
              </SelectItem>
            </SelectContent>
          </Select>
          <Switch
            :model-value="row.required"
            aria-label="缺失该字段的行是否丢弃"
            @update:model-value="(v: boolean) => emit('updateRow', idx, { required: v })"
          />
          <Button
            variant="ghost"
            size="icon"
            :aria-label="row.advancedOpen ? '收起高级设置' : '展开高级设置'"
            @click="toggleAdvanced(idx, row)"
          >
            <ChevronUp v-if="row.advancedOpen" class="h-4 w-4" />
            <ChevronDown v-else class="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="删除字段行"
            @click="emit('removeRow', idx)"
          >
            <Trash2 class="h-4 w-4" />
          </Button>
        </div>

        <!-- 高级展开区：key 逻辑名 / 单位 / 小数位 / 日期格式 -->
        <template v-if="row.advancedOpen">
          <div class="mt-2 grid items-start gap-2 rounded-md bg-muted/30 p-2" style="grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.1fr) minmax(0, 1.5fr) minmax(0, 0.8fr)">
            <div class="min-w-0">
              <label class="mb-1 block text-xs text-muted-foreground">
                逻辑名 key（小写字母开头，接口内唯一）
              </label>
              <Input
                :model-value="row.key"
                placeholder="留空自动派生"
                class="font-mono"
                @update:model-value="emit('updateRow', idx, { key: String($event ?? '') })"
              />
            </div>
            <div class="min-w-0">
              <label class="mb-1 block text-xs text-muted-foreground">单位</label>
              <Select
                :model-value="row.unit || 'none'"
                :disabled="!props.schema"
                @update:model-value="(v: string) => patchUnit(idx, v)"
              >
                <SelectTrigger class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="u in props.schema?.units ?? []"
                    :key="u"
                    :value="u"
                  >
                    {{ u }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <template v-if="row.type === 'decimal'">
              <div class="min-w-0">
                <label class="mb-1 block text-xs text-muted-foreground">小数位（0~8）</label>
                <Input
                  :model-value="row.scale"
                  type="number"
                  placeholder="可选"
                  @update:model-value="emit('updateRow', idx, { scale: String($event ?? '') })"
                />
              </div>
            </template>
            <template v-if="row.type === 'date'">
              <div class="min-w-0">
                <label class="mb-1 block text-xs text-muted-foreground">日期格式（如 %Y-%m-%d）</label>
                <Input
                  :model-value="row.dateFormat"
                  placeholder="可选"
                  class="font-mono"
                  @update:model-value="emit('updateRow', idx, { dateFormat: String($event ?? '') })"
                />
              </div>
            </template>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
