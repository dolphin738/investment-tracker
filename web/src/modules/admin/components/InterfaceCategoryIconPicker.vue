<script setup lang="ts">
/**
 * modules/admin/components/InterfaceCategoryIconPicker.vue — 可搜索的 lucide 图标下拉选择器
 *
 * 用于「接口分类」编辑/新增对话框中，替代原先的纯文本图标名输入框。
 * - v-model 绑定图标名（lucide PascalCase，如 "List"），与 interface-category.api 的
 *   icon 字段契约一致（后端存 lucide 名字符串）。
 * - 触发器：显示当前已选图标（若有）+ 文案；已选时右侧提供清空（X）。
 * - 面板：SearchInput 关键字过滤 + 可滚动网格（grid-cols-8）的图标按钮列表。
 * - 全量 registry：import { icons } from 'lucide-vue-next'（约 1500 个，键为 PascalCase 名）。
 *   过滤结果渲染上限 200 项，超出时面板底部提示「匹配过多，请细化搜索」。
 * - 点击外部 / 焦点移出由全局监听处理关闭；选中后关闭面板并同步 form.icon。
 *
 * 实现说明：复用现有 UI 组件 SearchInput、Button；下拉面板采用与
 * components/common/SecuritySearchCombobox.vue 一致的「relative 容器 + 绝对定位面板 +
 * 点击外部关闭」手写方案，避免 reka-ui DropdownMenu 内含可输入控件时的焦点/失焦关闭怪异行为。
 *
 * Bundle 取舍：icons 全量注册表会随 AdminPage（路由懒加载）进入 admin 路由 chunk，
 * 不进入首屏主包；与管理端既有的 DynamicIcon（动态 import 全量 lucide）范围一致，可接受。
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Component } from 'vue';
import { icons } from 'lucide-vue-next';
import { ChevronsUpDown, X } from 'lucide-vue-next';
import { SearchInput } from '@/components/ui/search-input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ICON_GROUPS, CATALOG_ICON_SET } from './icon-catalog';

const props = withDefaults(
  defineProps<{
    /** 当前选中的图标名（lucide PascalCase），通过 v-model 绑定 */
    modelValue?: string | null;
    disabled?: boolean;
    /** 透传到触发器，便于 Label 的 for 关联 */
    id?: string;
  }>(),
  { modelValue: '', disabled: false, id: undefined },
);

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

/** lucide 全量注册表（键为 PascalCase 图标名），转为可字符串索引的记录以便按名取用 */
const iconRegistry = icons as unknown as Record<string, Component>;

const open = ref<boolean>(false);
const query = ref<string>('');
const rootEl = ref<HTMLElement | null>(null);

/** 全部图标名（PascalCase），按字母排序，保证展示顺序稳定 */
const allNames = Object.keys(iconRegistry).sort((a, b) => a.localeCompare(b));

/** 单次面板渲染上限，避免一次性挂载上千个 SVG 造成卡顿 */
const RENDER_LIMIT = 200;

/** 是否处于搜索态（决定是否走扁平全量过滤 vs 精选分组） */
const showFlat = computed<boolean>(() => query.value.trim().length > 0);

/** 搜索态：跨全量 registry 过滤（保留上限，避免卡顿） */
const flatMatches = computed<string[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return [];
  return allNames.filter((name) => name.toLowerCase().includes(q)).slice(0, RENDER_LIMIT);
});

const flatTotal = computed<number>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return 0;
  return allNames.filter((name) => name.toLowerCase().includes(q)).length;
});

const isTruncated = computed<boolean>(() => showFlat.value && flatTotal.value > RENDER_LIMIT);

/** 非搜索态：按语义分组展示精选图标（仅保留真实存在的图标名） */
const groupedView = computed(() =>
  ICON_GROUPS.map((g) => ({
    label: g.label,
    icons: g.icons.filter((n) => iconRegistry[n]),
  })).filter((g) => g.icons.length > 0),
);

/** 当前已选图标组件（用于触发器回显），不存在时回退 null */
const selectedIcon = computed<Component | null>(() => {
  const name = props.modelValue;
  if (!name) return null;
  return iconRegistry[name] ?? null;
});

function openMenu(): void {
  if (props.disabled) return;
  clearBlurTimer();
  open.value = true;
}

function closeMenu(): void {
  open.value = false;
}

function toggleMenu(): void {
  if (open.value) closeMenu();
  else openMenu();
}

function handleSelect(name: string): void {
  emit('update:modelValue', name);
  closeMenu();
  query.value = '';
}

function clearSelection(e: MouseEvent): void {
  // 阻止冒泡，避免触发触发器 toggle
  e.stopPropagation();
  emit('update:modelValue', '');
}

// ---- 点击外部 / 焦点移出 关闭 ----

function handlePointerDownOutside(e: PointerEvent): void {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) {
    open.value = false;
  }
}

let blurTimer: ReturnType<typeof setTimeout> | undefined;

function clearBlurTimer(): void {
  if (blurTimer) {
    clearTimeout(blurTimer);
    blurTimer = undefined;
  }
}

function handleFocusOut(e: FocusEvent): void {
  const related = e.relatedTarget as Node | null;
  if (related && rootEl.value?.contains(related)) return;
  clearBlurTimer();
  blurTimer = setTimeout(() => {
    open.value = false;
  }, 120);
}

// 面板打开时自动聚焦搜索框，提升键盘可用性
watch(open, (visible) => {
  if (visible) {
    nextTick(() => {
      const input = rootEl.value?.querySelector('input');
      (input as HTMLInputElement | null)?.focus();
    });
  } else {
    query.value = '';
  }
});

onMounted(() => {
  document.addEventListener('pointerdown', handlePointerDownOutside, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDownOutside, true);
  clearBlurTimer();
});
</script>

<template>
  <div ref="rootEl" class="relative" @focusout="handleFocusOut">
    <!-- 触发器 -->
    <Button
      :id="props.id"
      type="button"
      variant="outline"
      class="w-full justify-between font-normal"
      :disabled="props.disabled"
      @click="toggleMenu"
    >
      <span class="flex min-w-0 items-center gap-2">
        <component :is="selectedIcon" v-if="selectedIcon" class="h-4 w-4 shrink-0" />
        <span class="truncate">{{ props.modelValue || '选择图标' }}</span>
      </span>
      <ChevronsUpDown class="ml-2 h-4 w-4 shrink-0 opacity-50" />
    </Button>

    <!-- 已选时提供清空按钮（与触发器同级，避免 button 嵌套导致非法 HTML） -->
    <button
      v-if="props.modelValue"
      type="button"
      aria-label="清空图标"
      class="absolute right-9 top-1/2 z-10 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      @click="clearSelection"
    >
      <X class="h-3.5 w-3.5" />
    </button>

    <!-- 面板：绝对定位，不抢占文档流；点击外部由全局 pointerdown 监听关闭 -->
    <div
      v-if="open"
      class="absolute left-0 top-full z-50 mt-1 w-96 rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
    >
      <div class="mb-2">
        <SearchInput v-model="query" placeholder="搜索图标，如 list / chart" />
      </div>

      <div class="max-h-64 overflow-y-auto rounded-md p-1">
        <!-- 当前所选图标若不在精选目录（如历史系统分类图标），顶部单独回显以便取消 -->
        <div
          v-if="props.modelValue && !CATALOG_ICON_SET.has(props.modelValue)"
          class="mb-2 flex items-center gap-2 rounded-md bg-accent px-2 py-1.5 text-accent-foreground"
        >
          <component
            :is="iconRegistry[props.modelValue]"
            v-if="iconRegistry[props.modelValue]"
            class="h-4 w-4"
          />
          <span class="text-xs">当前所选：{{ props.modelValue }}</span>
        </div>

        <!-- 搜索态：扁平全量过滤 -->
        <template v-if="showFlat">
          <div class="grid grid-cols-8 gap-1">
            <button
              v-for="name in flatMatches"
              :key="name"
              type="button"
              :title="name"
              :aria-label="name"
              class="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              :class="
                cn(
                  props.modelValue === name &&
                    'bg-accent text-accent-foreground ring-1 ring-ring',
                )
              "
              @click="handleSelect(name)"
            >
              <component :is="iconRegistry[name]" class="h-4 w-4" />
            </button>
          </div>
          <p
            v-if="flatMatches.length === 0"
            class="py-6 text-center text-xs text-muted-foreground"
          >
            无匹配图标
          </p>
          <p
            v-if="isTruncated"
            class="mt-1 px-1 text-center text-xs text-muted-foreground"
          >
            匹配过多（{{ flatTotal }} 个），请细化搜索
          </p>
        </template>

        <!-- 非搜索态：按语义分组展示 -->
        <template v-else>
          <div v-for="grp in groupedView" :key="grp.label" class="mb-2">
            <p class="px-1 pb-1 text-xs text-muted-foreground">{{ grp.label }}</p>
            <div class="grid grid-cols-8 gap-1">
              <button
                v-for="name in grp.icons"
                :key="name"
                type="button"
                :title="name"
                :aria-label="name"
                class="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                :class="
                  cn(
                    props.modelValue === name &&
                      'bg-accent text-accent-foreground ring-1 ring-ring',
                  )
                "
                @click="handleSelect(name)"
              >
                <component :is="iconRegistry[name]" class="h-4 w-4" />
              </button>
            </div>
          </div>
          <p
            v-if="groupedView.length === 0"
            class="py-6 text-center text-xs text-muted-foreground"
          >
            无可用图标
          </p>
        </template>
      </div>
    </div>
  </div>
</template>
