<script setup lang="ts">
/**
 * modules/security-trade/components/SecurityTradeForm.vue — 证券买卖录入/编辑弹窗表单（门面）
 *
 * 平移自 React 版 features/security-trade/security-trade-form.tsx,
 * schema 与错误消息逐字一致,录入 / 编辑共用同一 schema + 同一布局。
 *
 * - 统一字段与顺序:方向 → 日期 → 标的 → 资产类型 → 数量 → 成交额 → 费用三框
 *   (佣金/印花税/其他)→ 成本价(含费单价,只读预览)→ 备注
 * - 统一公式(K-3,买入/卖出同式):
 *   - 买入:costPrice = (成交额 + 费用合计) / 数量
 *   - 卖出:costPrice = (成交额 − 费用合计) / 数量;费用合计 > 成交额 → 阻止(C-7 前端闸)
 * - 编辑态回填:费用三框直接取自 trade.commission/stampTax/other;成交额按口径回填
 *   q × costPrice −/+ feeTotal(含费单价金融算法不变)。
 *
 * 表单引擎由 react-hook-form + zodResolver 换为 vee-validate + zod
 * (桥接函数见 lib/zod-typed-schema),校验规则与提示文案不变。
 *
 * INC-04 物理并表:费用明细直接承载于 security_trades 一行,feeTotal = 三列之和。
 *
 * §4 单文件 ≤400 行纯位置拆分（零行为变更）：schema/选项/回填工具 → security-trade-schema.ts；
 * 基础字段块 → SecurityTradeCoreFields.vue；费用/成本价/备注/提示尾部区块 → SecurityTradeFeeFields.vue。
 * 子组件均为纯展示（props 进 / emit 出,不新建数据 hook）;门面保留全部数据 hook 与提交逻辑。
 */

import { computed, ref, watch } from 'vue';
import { useForm } from 'vee-validate';
import { useMutation, useQuery } from '@tanstack/vue-query';
import { Loader2 } from 'lucide-vue-next';
import { toast } from '@/composables/use-toast';
import { Button } from '@/components/ui/button';
import {
  useCreateSecurityTrade,
  useUpdateSecurityTrade,
} from '../composables/use-security-trades';
import { useSecurities } from '@/composables/use-securities';
import { resolveSecurity, updateSecurity, getSecurity } from '@/api/security.api';
import type { SecurityDetailResponse } from '@/api/security.api';
import { toIsoDate } from '@/lib/constants';
import { SecuritySide, SecurityType, sumMoney } from '@/lib/types';
import { zodToTypedSchema } from '@/lib/zod-typed-schema';
import type {
  CreateSecurityTradeRequest,
  SecurityTradeResponse,
  UpdateSecurityDto,
} from '@/api/types';
import { createResetDefaults, toPrecision6, tradeSchema } from './security-trade-schema';
import type { TradeFormValues } from './security-trade-schema';
import SecurityTradeCoreFields from './SecurityTradeCoreFields.vue';
import SecurityTradeFeeFields from './SecurityTradeFeeFields.vue';

const props = defineProps<{
  portfolioId: string;
  /** 传入则编辑,否则新建 */
  trade?: SecurityTradeResponse | null;
}>();

/** 提交成功后回调(关闭弹窗) */
const emit = defineEmits<{ success: [] }>();

const isEdit = computed(() => Boolean(props.trade));
const createMutation = useCreateSecurityTrade();
const updateMutation = useUpdateSecurityTrade();

/** 手动修改资产类型(PATCH /securities/:id)- mutation 布尔态供禁用判断 */
const updateSecurityMutation = useMutation({
  mutationFn: ({
    securityId,
    payload,
  }: {
    securityId: string;
    payload: UpdateSecurityDto;
  }) => updateSecurity(props.portfolioId, securityId, payload),
});
const updateSecurityPending = computed(() => updateSecurityMutation.isPending.value);

const { data: securities, isLoading: secLoading } = useSecurities(props.portfolioId);
const today = toIsoDate(new Date());
const submitting = ref(false);
const currentSecurityType = ref<SecurityType | null>(null);
/**
 * 当前选中标的的展示元数据（编辑错位标的修复）：resolve 成功后缓存选中主数据的
 * name/code/type，使「当前标的不在组合证券字典内」时也能正确回显名称与资产类型，
 * 不再停滞在「加载中 / 已不在可选列表」。
 */
const resolvedSecurity = ref<{
  id: string;
  name: string;
  code: string;
  type: SecurityType;
} | null>(null);
const {
  handleSubmit,
  resetForm,
  errors,
  defineField,
} = useForm<TradeFormValues>({
  validationSchema: zodToTypedSchema(tradeSchema),
  initialValues: {
    date: today,
    // 编辑态首帧即按 trade.side 回填(避免方向栏空白「选择方向」);新建默认买入
    side: props.trade?.side ?? SecuritySide.BUY_SEC,
    securityId: '',
    quantity: '',
    tradeAmount: '',
    commission: '',
    stampTax: '',
    other: '',
    note: '',
  },
});

const [dateModel, dateAttrs] = defineField('date');
const [sideModel] = defineField('side');
const [securityIdModel] = defineField('securityId');
const [quantityModel, quantityAttrs] = defineField('quantity');
const [tradeAmountModel, tradeAmountAttrs] = defineField('tradeAmount');
const [commissionModel, commissionAttrs] = defineField('commission');
const [stampTaxModel, stampTaxAttrs] = defineField('stampTax');
const [otherModel, otherAttrs] = defineField('other');
const [noteModel, noteAttrs] = defineField('note');
/**
 * 编辑态回填(I-01 验收 3/4):
 * - 费用三框直接取自 trade.commission/stampTax/other(INC-04 物理并表,无独立费用表)
 * - 成交额:新口径(含费单价口径) q × costPrice −/+ feeTotal
 */
watch(
  () => props.trade,
  (trade) => {
    // 切换记录时清掉手动覆盖的类型与缓存元数据,交由下方推导 watch 重新带出
    currentSecurityType.value = null;
    resolvedSecurity.value = null;
    if (trade) {
      const feeTotal = Number(trade.feeTotal);
      const baseAmount = Number(trade.quantity) * Number(trade.costPrice);
      const tradeAmount =
        trade.side === SecuritySide.BUY_SEC
          ? baseAmount - feeTotal
          : baseAmount + feeTotal;
      resetForm({
        values: {
          date: trade.date,
          side: trade.side,
          securityId: trade.securityId,
          quantity: trade.quantity,
          tradeAmount: toPrecision6(tradeAmount),
          commission: trade.commission || '',
          stampTax: trade.stampTax || '',
          other: trade.other || '',
          note: trade.note ?? '',
        },
      });
    } else {
      resetForm({
        values: {
          date: today,
          side: SecuritySide.BUY_SEC,
          securityId: '',
          quantity: '',
          tradeAmount: '',
          commission: '',
          stampTax: '',
          other: '',
          note: '',
        },
      });
    }
  },
  { immediate: true },
);

/**
 * 标的下拉的受控值(INC-02):恒含 trade.securityId,保证编辑态任何时刻 value 都能命中选项
 * (securities 异步未到时表单 securityId 已写入,但下拉暂无对应项)。
 */
const selectedSecurityId = computed(
  () => (securityIdModel.value as string) || props.trade?.securityId || '',
);

/**
 * 资产类型首帧推导:编辑态 / 异步加载完成后,从标的列表推导当前资产类型;
 * 仅在尚未被手动覆盖(currentSecurityType 为 null)时推导。
 * 组合字典未命中时回退到 resolve 缓存元数据(resolvedSecurity),避免「加载中」停滞。
 */
watch(
  [securities, selectedSecurityId, currentSecurityType, resolvedSecurity],
  () => {
    if (currentSecurityType.value || !selectedSecurityId.value) return;
    const found = (securities.value ?? []).find(
      (s) => s.id === selectedSecurityId.value,
    );
    if (found?.type) {
      currentSecurityType.value = found.type as SecurityType;
      return;
    }
    if (resolvedSecurity.value?.id === selectedSecurityId.value) {
      currentSecurityType.value = resolvedSecurity.value.type;
    }
  },
);

/**
 * 编辑态标的详情兜底拉取：当 trade.securityId 不在组合证券字典（securities 列表）内时
 * （如录入时 resolve 懒实例化的新标的、列表分页未覆盖、或缓存滞后），按 id 主动拉取该标的
 * 详情并回填 resolvedSecurity，驱动「标的名称」「资产类型」正确显示，彻底消除
 * 「已不在可选列表 / 无法推断类型」。列表字典已含该标的时 disabled，不发起多余请求
 * （交给子组件 selectedSecurityLabel / 门面 currentSecurityType 既有的 find 逻辑）。
 */
const secDetailQuery = useQuery<SecurityDetailResponse>({
  queryKey: ['security', 'detail', props.portfolioId, selectedSecurityId],
  queryFn: () => getSecurity(props.portfolioId, selectedSecurityId.value),
  enabled: computed(() => {
    const id = selectedSecurityId.value;
    if (!id) return false;
    const inList = (securities.value ?? []).some((s) => s.id === id);
    return !inList && resolvedSecurity.value?.id !== id;
  }),
  retry: false,
});
watch(
  () => secDetailQuery.data.value,
  (detail) => {
    if (detail && detail.id === selectedSecurityId.value) {
      resolvedSecurity.value = {
        id: detail.id,
        name: detail.name,
        code: detail.code,
        type: detail.type as SecurityType,
      };
    }
  },
);
const secDetailLoading = computed(() => secDetailQuery.isLoading.value);

/** 选中系统主数据 → resolve 懒实例化为组合标的,回填 securityId(ADR-003) */
const resolveSecurityMutation = useMutation({
  mutationFn: (masterId: string) =>
    resolveSecurity(props.portfolioId, { masterId }),
  onSuccess: (res) => {
    securityIdModel.value = res.id;
    // 记录当前证券的类型(后端由代码前缀推断)与展示元数据,供手动修改/错位标回显使用
    currentSecurityType.value = res.type as SecurityType;
    resolvedSecurity.value = {
      id: res.id,
      name: res.name,
      code: res.code,
      type: res.type as SecurityType,
    };
  },
});

function handleSelectMaster(master: { id: string }): void {
  resolveSecurityMutation.mutate(master.id);
}

function handleClear(): void {
  securityIdModel.value = '';
  currentSecurityType.value = null;
  resolvedSecurity.value = null;
}

/** 手动修改资产类型 */
function handleSecurityTypeChange(newType: SecurityType): void {
  if (
    !selectedSecurityId.value ||
    !currentSecurityType.value ||
    newType === currentSecurityType.value
  ) {
    return;
  }
  updateSecurityMutation.mutate(
    {
      securityId: selectedSecurityId.value,
      payload: { type: newType },
    },
    {
      onSuccess: () => {
        currentSecurityType.value = newType;
        toast.success('资产类型已更新');
      },
    },
  );
}

/**
 * 统一保存流程(I-01 验收 6,两态对称):提交单笔 /security-trades,
 * INC-04 物理并表承载 { date, side, securityId, quantity, costPrice(含费单价),
 * commission, stampTax, other, feeTotal }。
 * 成功后以 createResetDefaults(today) 同帧构造重置值（原 resetDefaults 常量,行为不变）。
 */
const onSubmit = handleSubmit((values) => {
  submitting.value = true;
  const feeTotalStr = sumMoney([
    values.commission || '0',
    values.stampTax || '0',
    values.other || '0',
  ]);
  const qty = Number(values.quantity);
  const amount = Number(values.tradeAmount);
  const raw =
    (values.side === SecuritySide.BUY_SEC
      ? amount + Number(feeTotalStr)
      : amount - Number(feeTotalStr)) / qty;
  const costPrice = Number(raw.toFixed(6));

  const payload: CreateSecurityTradeRequest = {
    securityId: values.securityId,
    date: values.date,
    side: values.side,
    quantity: qty,
    costPrice,
    commission: Number(values.commission || '0'),
    stampTax: Number(values.stampTax || '0'),
    other: Number(values.other || '0'),
    feeTotal: Number(feeTotalStr),
    note: values.note || undefined,
  };

  const handleSettled = (): void => {
    submitting.value = false;
  };
  const handleError = (): void => {
    toast.error('保存失败，请稍后重试');
  };
  const handleSuccess = (): void => {
    resetForm({ values: createResetDefaults(today) });
    emit('success');
  };

  if (isEdit.value && props.trade) {
    updateMutation.mutate(
      { portfolioId: props.portfolioId, id: props.trade.id, payload },
      {
        onSettled: handleSettled,
        onError: handleError,
        onSuccess: handleSuccess,
      },
    );
  } else {
    createMutation.mutate(
      { portfolioId: props.portfolioId, payload },
      {
        onSettled: handleSettled,
        onError: handleError,
        onSuccess: handleSuccess,
      },
    );
  }
});
</script>

<template>
  <form @submit="onSubmit">
    <div class="space-y-4">
      <SecurityTradeCoreFields
        v-model:side-model="sideModel"
        v-model:date-model="dateModel"
        :date-attrs="dateAttrs"
        v-model:quantity-model="quantityModel"
        :quantity-attrs="quantityAttrs"
        v-model:trade-amount-model="tradeAmountModel"
        :trade-amount-attrs="tradeAmountAttrs"
        :errors="errors"
        :max-date="today"
        :securities="securities"
        :sec-loading="secLoading"
        :sec-detail-loading="secDetailLoading"
        :selected-security-id="selectedSecurityId"
        :resolved-security="resolvedSecurity"
        :current-security-type="currentSecurityType"
        :update-security-pending="updateSecurityPending"
        @select-master="handleSelectMaster"
        @clear="handleClear"
        @security-type-change="handleSecurityTypeChange"
      />
      <SecurityTradeFeeFields
        v-model:commission-model="commissionModel"
        :commission-attrs="commissionAttrs"
        v-model:stamp-tax-model="stampTaxModel"
        :stamp-tax-attrs="stampTaxAttrs"
        v-model:other-model="otherModel"
        :other-attrs="otherAttrs"
        v-model:note-model="noteModel"
        :note-attrs="noteAttrs"
        :quantity-model="quantityModel"
        :trade-amount-model="tradeAmountModel"
        :side-model="sideModel"
        :errors="errors"
      />
    </div>

    <div class="mt-6 flex justify-end gap-2">
      <Button type="submit" :disabled="submitting">
        <Loader2 v-if="submitting" class="mr-2 h-4 w-4 animate-spin" />
        {{ isEdit ? '保存' : '录入' }}
      </Button>
    </div>
  </form>
</template>
