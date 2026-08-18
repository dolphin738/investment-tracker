<script setup lang="ts">
/**
 * modules/auth/components/AccountRestorePrompt.vue — 注销冷静期恢复引导卡片
 *
 * 自 React 版 web/src/features/auth/account-restore-prompt.tsx 平移。
 * 登录页在捕获到业务码 1007（账户处于注销冷静期）时，不再当作普通登录失败，
 * 而是切换到本卡片：向用户说明当前处于 N 天冷静期，并提供「恢复账户 /
 * 暂不恢复」两个动作（SYS-P1-02 · PRD §7.10）。
 *
 * 设计要点：
 * - 这一状态是「可自助恢复的信号」而非错误，因此不依赖全局 toast
 *   （api-client 已把 1007 列入 SILENT_CODES，不弹红色提示）。
 * - 恢复所需的邮箱 + 密码由登录页透传，本组件只负责呈现与触发回调，
 *   不持有任何凭证。
 * - 失败分支（1008 未注销 / 1009 已过冷静期 / 1001 密码错）由拦截器统一 toast，
 *   本组件无需处理。
 */
import { Loader2, AlertTriangle } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

/** 冷静期剩余天数（来自后端 data.remainingDays，向上取整，区间 [1, 30]） */
const props = defineProps<{
  remainingDays: number;
  /** 恢复进行中：按钮 loading + 禁用，避免重复提交 */
  isRestoring: boolean;
}>();

/** restore：点击「恢复账户」（登录页据此调用 useRestoreAccount）；dismiss：点击「暂不恢复」回到普通登录表单 */
const emit = defineEmits<{
  (e: 'restore'): void;
  (e: 'dismiss'): void;
}>();
</script>

<template>
  <Card class="w-full max-w-md">
    <CardHeader>
      <CardTitle class="text-2xl">账户处于注销冷静期</CardTitle>
      <CardDescription>
        你的账户已申请注销，目前处于 {{ props.remainingDays }} 天冷静期内。在冷静期结束前，你仍可凭登录密码一键恢复账户。
      </CardDescription>
    </CardHeader>
    <CardContent>
      <div class="flex gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          恢复后，账户及其全部投资数据（组合、持仓、出入金、净值快照等）将立即恢复正常，且无需重新登录。
        </p>
      </div>
    </CardContent>
    <CardFooter class="flex flex-col space-y-3">
      <Button
        type="button"
        class="w-full"
        :disabled="props.isRestoring"
        @click="emit('restore')"
      >
        <Loader2 v-if="props.isRestoring" class="mr-2 h-4 w-4 animate-spin" />
        恢复账户
      </Button>
      <Button
        type="button"
        variant="ghost"
        class="w-full"
        :disabled="props.isRestoring"
        @click="emit('dismiss')"
      >
        暂不恢复
      </Button>
    </CardFooter>
  </Card>
</template>
