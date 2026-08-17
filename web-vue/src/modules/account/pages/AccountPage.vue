<script setup lang="ts">
/**
 * modules/account/pages/AccountPage.vue — 账户页（B14 批次）
 *
 * 账户资料卡 + 三个维护对话框（编辑资料 / 改邮箱 / 改密码）。
 * 自 React 版 web/src/pages/AccountPage.tsx 的「个人信息」卡与
 * web/src/features/account/* 三个对话框平移并整合而成。
 */
import { ref } from 'vue';
import PageHeader from '@/components/common/PageHeader.vue';
import AccountInfoCard from '../components/AccountInfoCard.vue';
import ChangeEmailDialog from '../components/ChangeEmailDialog.vue';
import ChangePasswordDialog from '../components/ChangePasswordDialog.vue';
import EditProfileDialog from '../components/EditProfileDialog.vue';

const editOpen = ref(false);
const emailOpen = ref(false);
const passwordOpen = ref(false);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="账户"
      description="账户资料与登录安全设置（修改邮箱、密码与个人资料）"
    />
    <div class="grid grid-cols-1 gap-6 xl:grid-cols-12">
      <AccountInfoCard
        class="xl:col-span-3"
        @edit-profile="editOpen = true"
        @change-email="emailOpen = true"
        @change-password="passwordOpen = true"
      />
    </div>

    <ChangeEmailDialog :open="emailOpen" @open-change="emailOpen = $event" />
    <ChangePasswordDialog
      :open="passwordOpen"
      @open-change="passwordOpen = $event"
    />
    <EditProfileDialog :open="editOpen" @open-change="editOpen = $event" />
  </div>
</template>