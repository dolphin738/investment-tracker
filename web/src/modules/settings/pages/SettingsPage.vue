<script setup lang="ts">
/**
 * modules/settings/pages/SettingsPage.vue — 设置页
 *
 * 自 React 版 web/src/pages/settings.tsx 平移，包含：
 * - 账户：用户信息摘要 + 操作入口（修改邮箱 / 修改密码 / 编辑资料 / 退出登录）
 * - 偏好设置：服务端持久化（usePreferences + 乐观更新 useUpdatePreferences）
 * - 数据管理：导出 / 导入（B13 批次已接入，本页保留）
 * - 危险操作区：清空当前组合数据 / 注销账户（AlertDialog 二次确认）
 *
 * 组合管理（新建 / 编辑 / 归档 / 删除 / 设为默认）已整体迁出本页，
 * 收敛到账户页 /account 的「我的组合」卡；本页仅读取组合列表供
 * 「默认组合」下拉与导出 / 导入 / 清空数据使用。
 *
 * 【偏好同步口径】与 React 版一致：
 * - 服务端偏好加载后写入 preference.store（全站共享），并回填本地表单；
 * - 修改后点「保存偏好」乐观更新（失败回滚），成功后覆盖偏好 store 并切默认组合；
 * - QUICK_RANGE_OPTIONS / RESOLVED 统一取自 '@/modules/query/quick-range'（唯一真相源）。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Loader2, Lock, LogOut, Mail, Pencil } from 'lucide-vue-next';
import PageHeader from '@/components/common/PageHeader.vue';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import UserAvatar from '@/components/common/UserAvatar.vue';
import ExportPanel from '@/modules/data-transfer/components/ExportPanel.vue';
import ImportDialog from '@/modules/data-transfer/components/ImportDialog.vue';
import ImportTemplateButtons from '@/modules/data-transfer/components/ImportTemplateButtons.vue';
import ChangeEmailDialog from '@/modules/account/components/ChangeEmailDialog.vue';
import ChangePasswordDialog from '@/modules/account/components/ChangePasswordDialog.vue';
import EditProfileDialog from '@/modules/account/components/EditProfileDialog.vue';
import { useAuthStore, useIsAdmin } from '@/stores/auth.store';
import { usePortfolioStore } from '@/stores/portfolio.store';
import {
  useClearPortfolioData,
  usePortfolios,
} from '@/modules/portfolio/composables/use-portfolios';
import { useDeleteAccount } from '@/modules/account/composables/use-account';
import { ROUTE_PATH } from '@/lib/constants';
import PrefsDividendTab from '../components/PrefsDividendTab.vue';
import SettingsPreferencesTab from '../components/SettingsPreferencesTab.vue';

const router = useRouter();
const authStore = useAuthStore();
const user = computed(() => authStore.user);
const portfolioStore = usePortfolioStore();

// 组合列表仍需读取：偏好区「默认组合」下拉、导出面板、导入对话框、清空数据都依赖它。
const portfoliosQuery = usePortfolios();
const portfolios = computed(() => portfoliosQuery.data.value ?? []);
const currentPortfolioId = computed(() => portfolioStore.currentPortfolioId);
const currentPortfolio = computed(
  () => portfolios.value.find((p) => p.id === currentPortfolioId.value) ?? null,
);

// 数据管理：导入对话框开关（T05）
const importOpen = ref(false);

// 股息率配置 TAB 内容已抽至 components/PrefsDividendTab.vue（§10.4：容器只做组合）
const isAdmin = computed(() => useIsAdmin());
// 默认激活 TAB：偏好设置（既有测试直接 mount 后即访问偏好元素，需保证首帧可见）
const activeTab = ref('preferences');

// 账户修改对话框显隐
const emailDialogOpen = ref(false);
const passwordDialogOpen = ref(false);
const profileDialogOpen = ref(false);

// 注销账户（危险操作 · SET-P1-06）
const deleteAccountOpen = ref(false);
const deleteAccountEmail = ref('');
const deleteAccountMutation = useDeleteAccount();

// 清空当前组合数据（危险操作 · SET-P0-05）
const clearDataOpen = ref(false);
const clearDataConfirmName = ref('');
const clearDataMutation = useClearPortfolioData();

/** 手机号脱敏展示 */
const maskedPhone = computed(() =>
  user.value?.phone
    ? `${user.value.phone.slice(0, 3)}****${user.value.phone.slice(7)}`
    : '-',
);

/** 退出登录 */
function handleLogout(): void {
  authStore.logout();
  router.push(ROUTE_PATH.LOGIN);
}

/** 确认清空当前组合数据 */
function confirmClearData(): void {
  if (!currentPortfolio.value) return;
  clearDataMutation.mutate(currentPortfolio.value.id, {
    onSuccess: () => {
      clearDataOpen.value = false;
      clearDataConfirmName.value = '';
    },
  });
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="设置"
      description="管理账户与偏好设置（新建 / 编辑 / 归档 / 删除组合请前往账户页「我的组合」）"
    />

    <!-- 页签：账户 / 偏好设置 / 股息率(admin) / 数据管理 / 危险操作区 -->
    <Tabs v-model="activeTab" class="space-y-6">
      <TabsList>
        <TabsTrigger value="account">账户</TabsTrigger>
        <TabsTrigger value="preferences">偏好设置</TabsTrigger>
        <TabsTrigger v-if="isAdmin" value="dividend">股息率</TabsTrigger>
        <TabsTrigger value="data">数据管理</TabsTrigger>
        <TabsTrigger value="danger">危险操作区</TabsTrigger>
      </TabsList>

      <!-- 账户 -->
      <TabsContent value="account">
      <Card>
      <CardHeader>
        <CardTitle class="text-base">账户</CardTitle>
        <CardDescription>当前登录用户信息与安全设置</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <!-- 头像 + 昵称 + 邮箱 + 账户中心入口（§7.8 L1315） -->
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center">
          <UserAvatar
            size="lg"
            :src="user?.avatar"
            :name="user?.name"
            :email="user?.email ?? ''"
          />
          <div class="min-w-0">
            <p class="truncate text-base font-medium">
              {{ user?.name || '未设置' }}
            </p>
            <p class="truncate text-sm text-muted-foreground">
              {{ user?.email ?? '-' }}
            </p>
          </div>
          <Button
            variant="link"
            size="sm"
            class="sm:ml-auto"
            @click="router.push(ROUTE_PATH.ACCOUNT)"
          >
            前往账户中心 →
          </Button>
        </div>

        <!-- 资料明细 -->
        <div class="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div>
            <Label class="text-xs text-muted-foreground">手机号</Label>
            <p class="mt-1 font-mono">{{ maskedPhone }}</p>
          </div>
          <div>
            <Label class="text-xs text-muted-foreground">个人简介</Label>
            <p class="mt-1 whitespace-pre-wrap break-words">
              {{ user?.bio || '-' }}
            </p>
          </div>
        </div>

        <!-- 操作区 -->
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" @click="emailDialogOpen = true">
            <Mail class="mr-2 h-4 w-4" />
            修改邮箱
          </Button>
          <Button variant="outline" size="sm" @click="passwordDialogOpen = true">
            <Lock class="mr-2 h-4 w-4" />
            修改密码
          </Button>
          <Button variant="outline" size="sm" @click="profileDialogOpen = true">
            <Pencil class="mr-2 h-4 w-4" />
            编辑资料
          </Button>
          <Button variant="outline" size="sm" @click="handleLogout">
            <LogOut class="mr-2 h-4 w-4" />
            退出登录
          </Button>
        </div>

        <!-- 头像修改提示（§7.8 L1318-1319） -->
        <p class="text-xs text-muted-foreground">
          Ⓘ 头像修改在「编辑资料」卡片内完成（本地上传 与 头像 URL 并列）；本区只展示头像，不提供独立的「头像 URL」输入框
        </p>
      </CardContent>
    </Card>
      </TabsContent>

      <!-- 偏好设置 -->
      <TabsContent value="preferences">
        <SettingsPreferencesTab />
      </TabsContent>

      <!-- 股息率（admin-only）：内容承载于 PrefsDividendTab（§10.4） -->
      <TabsContent v-if="isAdmin" value="dividend">
        <PrefsDividendTab />
      </TabsContent>

    <!-- 数据管理（T05 · SET-P0-03 导出 / SET-P0-04 导入 / FLOW-P1-01） -->
      <TabsContent value="data">
      <Card>
      <CardHeader>
        <CardTitle class="text-base">数据管理</CardTitle>
        <CardDescription>
          CSV / Excel 导出与导入（导入支持 .csv / .xlsx / .xls）
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <!-- 导出（SET-P0-03）：7 类多选 + 格式 + 串行下载 -->
        <div class="space-y-2">
          <Label class="text-sm">导出</Label>
          <ExportPanel
            v-if="currentPortfolio"
            :portfolio-id="currentPortfolio.id"
            :portfolio-name="currentPortfolio.name"
          />
          <p v-else class="text-xs text-muted-foreground">
            请先在顶部选择一个投资组合
          </p>
        </div>

        <!-- 导入（SET-P0-04 / FLOW-P1-01）：预览 → 提交 -->
        <div class="space-y-2">
          <Label class="text-sm">导入</Label>
          <div class="flex flex-wrap items-center gap-2">
            <ImportTemplateButtons />
            <Button
              variant="outline"
              size="sm"
              :disabled="!currentPortfolio"
              @click="importOpen = true"
            >
              选择文件并导入…
            </Button>
          </div>
        </div>

        <p class="text-xs text-muted-foreground">
          Ⓘ 导入前建议先「导出」备份；证券买卖 / 出入金为追加写入，资产快照按日期覆盖。
        </p>
      </CardContent>
    </Card>
      </TabsContent>

    <!-- 导入对话框 -->
    <ImportDialog
      :portfolio-id="currentPortfolioId ?? ''"
      :open="importOpen"
      @open-change="importOpen = $event"
    />

    <!-- 危险操作区（SET-P0-05 清空数据 + SET-P1-06 注销账户） -->
      <TabsContent value="danger">
      <Card class="border-destructive/40">
      <CardHeader>
        <CardTitle class="text-base text-destructive">危险操作区</CardTitle>
        <CardDescription>以下操作不可恢复或代价极高，请谨慎执行</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <!-- 清空当前组合数据（SET-P0-05）：只清数据、保留组合 -->
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-sm font-medium">清空当前组合数据</p>
            <p class="text-xs text-muted-foreground">
              删除当前组合的全部出入金、证券买卖、净值与 XIRR 等数据，
              但保留组合本身（SET-P0-05）
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            class="text-destructive hover:text-destructive"
            :disabled="!currentPortfolio"
            :title="currentPortfolio ? undefined : '请先在顶部选择一个组合'"
            @click="
              clearDataConfirmName = '';
              clearDataOpen = true;
            "
          >
            清空数据
          </Button>
        </div>

        <!-- 注销账户（SET-P1-06）：软删除账户本身及全部数据 -->
        <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <div>
            <p class="text-sm font-semibold text-destructive">注销账户</p>
            <p class="text-xs text-muted-foreground">
              软删除账户本身及全部组合；30 天内可在登录页用原邮箱 + 密码自助恢复，
              超期由系统彻底删除（SET-P1-06）
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            @click="
              deleteAccountEmail = '';
              deleteAccountOpen = true;
            "
          >
            注销账户
          </Button>
        </div>
      </CardContent>
        </Card>
      </TabsContent>
    </Tabs>

    <!-- 账户修改对话框 -->
    <ChangeEmailDialog
      :open="emailDialogOpen"
      @open-change="emailDialogOpen = $event"
    />
    <ChangePasswordDialog
      :open="passwordDialogOpen"
      @open-change="passwordDialogOpen = $event"
    />
    <EditProfileDialog
      :open="profileDialogOpen"
      @open-change="profileDialogOpen = $event"
    />

    <!-- 注销账户确认（SET-P1-06：邮箱二次确认 + 软删除文案） -->
    <AlertDialog
      v-model:open="deleteAccountOpen"
      @update:open="deleteAccountOpen = $event"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认注销账户？</AlertDialogTitle>
          <!--
            PRD §7.8 L1400-1402 硬约束：本应用没有人工客服代恢复通道，
            文案严禁出现「如需恢复请联系客服」，必须写明「自助恢复」口径。
          -->
          <AlertDialogDescription>
            注销将删除账户本身及全部组合（软删除保留 30 天，到期后由系统彻底删除）。
            30 天内可在登录页用原邮箱 + 密码自助恢复；超过 30 天后数据将被系统彻底删除，不可找回。
            此操作与「清空当前组合数据」不同：后者仅清空单个组合数据、保留账户。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div class="space-y-2">
          <Label for="delete-account-email">
            请输入当前邮箱
            <span class="font-mono">{{ user?.email ?? '' }}</span>
            以确认
          </Label>
          <Input
            id="delete-account-email"
            type="email"
            :placeholder="user?.email ?? '请输入当前邮箱'"
            v-model="deleteAccountEmail"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel
            :disabled="deleteAccountMutation.isPending.value"
          >
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            :disabled="
              deleteAccountMutation.isPending.value ||
              deleteAccountEmail.trim() !== (user?.email ?? '')
            "
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="deleteAccountMutation.mutate()"
          >
            <Loader2
              v-if="deleteAccountMutation.isPending.value"
              class="mr-2 h-4 w-4 animate-spin"
            />
            确认注销
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- 清空当前组合数据确认（SET-P0-05：手动输入组合名称 + 列出删除类型） -->
    <AlertDialog v-model:open="clearDataOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认清空该组合数据？</AlertDialogTitle>
          <AlertDialogDescription>
            将删除组合「{{ currentPortfolio?.name ?? '' }}」下的以下全部数据，
            组合本身保留，此操作不可撤销：
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul class="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
          <li>出入金流水</li>
          <li>证券买卖流水</li>
          <li>标的最新价 / 现金余额</li>
          <li>总资产记录（快照）</li>
          <li>每日净值 / 每日 XIRR</li>
          <li>分红 / 费用</li>
        </ul>
        <div class="space-y-2">
          <Label for="clear-data-confirm">
            请输入组合名称
            <span class="font-mono">{{ currentPortfolio?.name ?? '' }}</span>
            以确认
          </Label>
          <Input
            id="clear-data-confirm"
            :placeholder="currentPortfolio?.name ?? '请输入组合名称'"
            v-model="clearDataConfirmName"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel
            :disabled="clearDataMutation.isPending.value"
          >
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            :disabled="
              clearDataMutation.isPending.value ||
              clearDataConfirmName.trim() !== (currentPortfolio?.name ?? '')
            "
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="confirmClearData"
          >
            <Loader2
              v-if="clearDataMutation.isPending.value"
              class="mr-2 h-4 w-4 animate-spin"
            />
            确认清空
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>