<script setup lang="ts">
/**
 * components/common/UserAvatar.vue — 用户头像
 *
 * 有 src 且图片加载成功时渲染 img；否则渲染圆形色块 + 名称/邮箱首字母。
 * 与 React 版一致：原生元素自建，零新增依赖。
 */
import { computed, ref, watch } from 'vue';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    /** 头像 URL，可为空 */
    src?: string | null;
    /** 显示名称，用于生成占位首字母 */
    name?: string | null;
    /** 邮箱，name 为空时用于生成占位首字母 */
    email: string;
    /** 尺寸：sm = 列表/导航；lg = 设置页大头像 */
    size?: 'sm' | 'lg';
    class?: string;
  }>(),
  { size: 'sm' },
);

/** 图片加载失败标记（src 变化时重置，允许新地址重新尝试） */
const failed = ref(false);

watch(
  () => props.src,
  () => {
    failed.value = false;
  },
);

/** 取占位首字母：优先 name，其次 email，统一大写 */
const initial = computed<string>(() => {
  const fromName = props.name?.trim()?.[0];
  if (fromName) {
    return fromName.toUpperCase();
  }
  const fromEmail = props.email?.trim()?.[0];
  return fromEmail ? fromEmail.toUpperCase() : '?';
});

const sizeClass = computed(() =>
  props.size === 'lg' ? 'h-16 w-16 text-xl' : 'h-9 w-9 text-sm',
);
const showImage = computed(() => Boolean(props.src) && !failed.value);
</script>

<template>
  <div
    :class="cn(
      'flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 font-medium text-primary',
      sizeClass,
      props.class,
    )"
    :title="name || email"
  >
    <img
      v-if="showImage"
      :src="src as string"
      :alt="name || email"
      class="h-full w-full object-cover"
      @error="failed = true"
    />
    <span v-else>{{ initial }}</span>
  </div>
</template>
