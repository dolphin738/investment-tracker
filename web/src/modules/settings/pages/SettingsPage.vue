<script setup lang="ts">
/**
 * modules/settings/pages/SettingsPage.vue — 个人中心（路由 /settings，原「设置页」）
 *
 * 自 React 版 web/src/pages/settings.tsx 平移，包含：
 * - 账户：用户信息摘要 + 操作入口（修改邮箱 / 修改密码 / 编辑资料 / 退出登录）
 * - 偏好设置：服务端持久化（usePreferences + 乐观更新 useUpdatePreferences）
 * - 数据管理：导出 / 导入（B13 批次已接入，本页保留）
 * - 危险操作区：清空当前组合数据 / 注销账户（AlertDialog 二次确认）
 *
 * 组合管理（新建 / 编辑 / 归档 / 删除 / 设为默认）已整体迁出本页，
 * 收敛到设置页「账户」TAB 的「我的组合」卡；本页仅读取组合列表供
 * 「默认组合」下拉与导出 / 导入 / 清空数据使用。
 *
 * 【偏好同步口径】与 React 版一致：
 * - 服务端偏好加载后写入 preference.store（全站共享），并回填本地表单；
 * - 修改后点「保存偏好」乐观更新（失败回滚），成功后覆盖偏好 store 并切默认组合；
 * - QUICK_RANGE_OPTIONS / RESOLVED 统一取自 '@/modules/query/quick-range'（唯一真相源）。
 *
 * 拆分说明：账户页签 → SettingsAccountTab；数据管理页签 → SettingsDataTab；
 * 危险操作区页签 → SettingsDangerTab。全部数据 hook（useProfile /
 * usePortfolios / useDeleteAccount / useClearPortfolioData）与弹窗开关状态
 * 仍保留在本门面，子组件纯展示（props 进 / emit 出）。
 */
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Loader2 } from 'lucide-vue-next';
import PageHeader from '@/components/common/PageHeader.vue';
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
import ImportDialog from '@/modules/data-transfer/components/ImportDialog.vue';
import ChangeEmailDialog from '@/modules/account/components/ChangeEmailDialog.vue';
import ChangePasswordDialog from '@/modules/account/components/ChangePasswordDialog.vue';
import EditProfileDialog from '@/modules/account/components/EditProfileDialog.vue';
import AutoSyncCard from '@/modules/account/components/AutoSyncCard.vue';
import { useAuthStore } from '@/stores/auth.store';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { useProfile } from '@/modules/auth/composables/use-auth';
import {
  useClearPortfolioData,
  usePortfolios,
} from '@/modules/portfolio/composables/use-portfolios';
import { useDeleteAccount } from '@/modules/account/composables/use-account';
import { ROUTE_PATH } from '@/lib/constants';
import SettingsPreferencesTab from '../components/SettingsPreferencesTab.vue';
import SettingsAccountTab from '../components/SettingsAccountTab.vue';
import SettingsDataTab from '../components/SettingsDataTab.vue';
import SettingsDangerTab from '../components/SettingsDangerTab.vue';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();
const user = computed(() => authStore.user);
const portfolioStore = usePortfolioStore();

// 账户页并入（ACC-P0-02 口径延续）：优先 GET /auth/profile 新鲜响应（回写 auth store），
// 回退 auth store 从 localStorage 恢复的旧缓存（旧缓存可能缺 createdAt）
const { data: freshProfile } = useProfile();
const currentUser = computed(() => freshProfile.value ?? user.value);

// 组合列表仍需读取：偏好区「默认组合」下拉、导出面板、导入对话框、清空数据都依赖它。
const portfoliosQuery = usePortfolios();
const portfolios = computed(() => portfoliosQuery.data.value ?? []);
const currentPortfolioId = computed(() => portfolioStore.currentPortfolioId);
const currentPortfolio = computed(
  () => portfolios.value.find((p) => p.id === currentPortfolioId.value) ?? null,
);

// 数据管理：导入对话框开关（T05）
const importOpen = ref(false);

// 默认激活 TAB：偏好设置（既有测试直接 mount 后即访问偏好元素，需保证首帧可见）；
// 支持 ?tab=account 等深链定位（/account 重定向落地用）
const VALID_TABS = ['account', 'preferences', 'data', 'danger'] as const;
const queryTab = route.query.tab;
const initialTab =
  typeof queryTab === 'string' &&
  (VALID_TABS as readonly string[]).includes(queryTab)
    ? queryTab
    : 'preferences';
const activeTab = ref<string>(initialTab);

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
  currentUser.value?.phone
    ? `${currentUser.value.phone.slice(0, 3)}****${currentUser.value.phone.slice(7)}`
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
      title="个人中心"
      description="账户中心与偏好设置 · 组合管理在「账户」页签的「我的组合」卡完成"
    />

    <!-- 页签：账户 / 偏好设置 / 数据管理 / 危险操作区 -->
    <Tabs v-model="activeTab" class="space-y-6">
      <TabsList>
        <TabsTrigger value="account">账户</TabsTrigger>
        <TabsTrigger value="preferences">偏好设置</TabsTrigger>
        <TabsTrigger value="data">数据管理</TabsTrigger>
        <TabsTrigger value="danger">危险操作区</TabsTrigger>
      </TabsList>

      <!-- 账户（账户中心已整体并入本页签：信息摘要 + 安全操作 + 资产/统计 + 组合管理） -->
      <TabsContent value="account" class="space-y-6">
        <SettingsAccountTab
          :current-user="currentUser"
          :masked-phone="maskedPhone"
          @open-email-dialog="emailDialogOpen = true"
          @open-password-dialog="passwordDialogOpen = true"
          @open-profile-dialog="profileDialogOpen = true"
          @logout="handleLogout"
        />
      </TabsContent>

      <!-- 偏好设置（含持仓行情同步卡） -->
      <TabsContent value="preferences" class="space-y-6">
        <SettingsPreferencesTab />
        <!-- 持仓行情同步（可写），独占整行 -->
        <AutoSyncCard />
      </TabsContent>

    <!-- 数据管理（T05 · SET-P0-03 导出 / SET-P0-04 导入 / FLOW-P1-01） -->
      <TabsContent value="data">
        <SettingsDataTab
          :current-portfolio="currentPortfolio"
          @open-import-dialog="importOpen = true"
        />
      </TabsContent>

    <!-- 导入对话框 -->
    <ImportDialog
      :portfolio-id="currentPortfolioId ?? ''"
      :open="importOpen"
      @open-change="importOpen = $event"
    />

    <!-- 危险操作区（SET-P0-05 清空数据 + SET-P1-06 注销账户） -->
      <TabsContent value="danger">
        <SettingsDangerTab
          :current-portfolio="currentPortfolio"
          @open-clear-dialog="() => {
            clearDataConfirmName = '';
            clearDataOpen = true;
          }"
          @open-delete-dialog="() => {
            deleteAccountEmail = '';
            deleteAccountOpen = true;
          }"
        />
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
