/**
 * features/security-income/dividend-fee-form.tsx — 分红录入编辑表单（HOLD-B-P0-10 + 增量 I-02）
 *
 * PRD §7.2【E】：分红 = 日期 / 标的 / 分红额（税前）/ 所得税（可选）/ 类型 / 备注
 *
 * ⚠️ 分红增量口径（K-1/K-2）：
 * - amount 恒为税前；tax ≥ 0；净额 = amount − tax，实时展示且 ≥ 0（前端阻止 + 后端兜底）
 * - 🔴 I-02 P0 修复：编辑分红 payload **必须携带 type**（后端全局 ValidationPipe
 *   forbidNonWhitelisted，缺 type 声明即 400「property type should not exist」）；
 *   所得税标签改「所得税（可选）」；编辑态 type 下拉可改（Q-1 建议允许）
 * - 净额由 shared computeNetAmount（整数分运算）计算，避免浮点毛刺
 *
 * ⚠️ D-02 / D-03：分红不进现金流、不触发重算。
 * ⚠️ INC-04 物理并表：费用录入已并入「录入买卖」的费用三联字段，本表单仅承载分红。
 */

import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Info, Loader2 } from 'lucide-react';
import { isMoneyString, computeNetAmount } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSecurities, useResolveSecurity } from '@/hooks/use-securities';
import {
  useCreateDividend,
  useUpdateDividend,
} from '@/hooks/use-dividends';
import { toIsoDate } from '@/lib/constants';
import { formatCurrency } from '@/lib/utils';
import { DividendType } from '@/api/types';
import type { DividendRecord } from '@/api/types';
import type { SecurityMaster } from '@/api/security-master.api';
import { SecuritySearchCombobox } from '@/components/security/security-search-combobox';

/** 分红类型中文映射（导出供列表复用） */
export const DIVIDEND_TYPE_LABEL: Record<string, string> = {
  CASH: '现金分红',
  STOCK_DIVIDEND: '红利再投',
};

/** 金额：> 0 且最多 2 位小数（PRD §8.1 NUMERIC(18,2)，格式校验收敛到 shared） */
const amountSchema = z
  .string()
  .min(1, '请输入金额')
  .refine((v) => isMoneyString(v), '金额最多 2 位小数')
  .refine((v) => Number(v) > 0, '金额必须大于 0');

/** 所得税：可选、≥ 0、最多 2 位小数（K-1） */
const taxSchema = z
  .string()
  .optional()
  .refine((v) => !v || /^-?\d+(\.\d{1,2})?$/.test(v), '所得税最多 2 位小数')
  .refine((v) => !v || Number(v) >= 0, '所得税不能为负');

const recordSchema = z
  .object({
    securityId: z.string().min(1, '请选择标的'),
    date: z
      .string()
      .min(1, '请选择日期')
      .refine((v) => v <= toIsoDate(new Date()), '日期不能为未来'),
    amount: amountSchema,
    tax: taxSchema,
    // 分红类型（编辑态可改，Q-1 建议允许；录入态固定 CASH）
    type: z.nativeEnum(DividendType).optional(),
    note: z.string().max(200, '备注最多 200 字').optional(),
  })
  // 分红净额 ≥ 0（税 > 税前 → 阻止提交；后端 PATCH/POST 同口径兜底）
  .refine(
    (v) => {
      if (!v.tax) return true;
      return Number(v.amount) - Number(v.tax) >= 0;
    },
    { path: ['tax'], message: '净额不能为负' },
  );

type RecordFormValues = z.infer<typeof recordSchema>;

export interface DividendFeeFormProps {
  portfolioId: string;
  /** 编辑态：分红传 DividendRecord（INC-04 后仅分红一种记录） */
  record?: DividendRecord | null;
  /** 提交成功后回调（关闭弹窗） */
  onSuccess?: () => void;
}

export function DividendFeeForm({
  portfolioId,
  record,
  onSuccess,
}: DividendFeeFormProps): JSX.Element {
  const isEdit = Boolean(record);
  const { data: securities = [], isLoading: secLoading } =
    useSecurities(portfolioId);
  const createDividend = useCreateDividend(portfolioId);
  const updateDividend = useUpdateDividend(portfolioId);
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<RecordFormValues>({
    resolver: zodResolver(recordSchema),
    defaultValues: {
      securityId: record?.securityId ?? '',
      date: record?.date ?? toIsoDate(new Date()),
      amount: record?.amount ?? '',
      tax: record && 'tax' in record ? (record.tax ?? '') : '',
      type:
        record && 'type' in record
          ? (record.type as DividendType | undefined)
          : DividendType.CASH,
      note: record?.note ?? '',
    },
  });

  const securityId = watch('securityId');
  const dividendType = watch('type');
  const amount = watch('amount');
  const tax = watch('tax');

  /** 选中系统主数据 → resolve 懒实例化为组合标的，回填 securityId（对齐「录入买卖」§10，ADR-003） */
  const resolveSecurityMutation = useResolveSecurity(portfolioId);
  const handleSelectMaster = (master: SecurityMaster): void => {
    resolveSecurityMutation.mutate(
      { masterId: master.id },
      {
        onSuccess: (res) => {
          setValue('securityId', res.id, { shouldValidate: true });
        },
      },
    );
  };

  /** 当前选中标的的展示文本（编辑态回显）：列表已到且含当前标的 → 「名称（代码）」 */
  const selectedSecurityLabel = useMemo(() => {
    if (!securityId) return '';
    const found = securities.find((s) => s.id === securityId);
    if (found) return `${found.name}（${found.code}）`;
    return secLoading ? '当前标的（加载中…）' : '当前标的（已不在可选列表）';
  }, [securities, securityId, secLoading]);

  /** 净额实时展示（整数分运算；输入未成型时显示占位） */
  const netAmount = useMemo(() => {
    if (!isMoneyString(amount) || !amount) return null;
    if (tax && !isMoneyString(tax)) return null;
    return computeNetAmount(amount, tax || '0');
  }, [amount, tax]);

  const onSubmit = async (values: RecordFormValues): Promise<void> => {
    setSubmitting(true);
    try {
      // 🔴 I-02：payload 必须携带 type（forbidNonWhitelisted 400 根因修复）
      const payload = {
        securityId: values.securityId,
        date: values.date,
        amount: values.amount,
        // Q-1 建议允许编辑 type：编辑态取下拉值；录入态固定现金分红
        type: values.type ?? DividendType.CASH,
        tax: values.tax || undefined,
        note: values.note || undefined,
      };
      if (isEdit && record) {
        await updateDividend.mutateAsync({ id: record.id, payload });
      } else {
        await createDividend.mutateAsync(payload);
      }
      onSuccess?.();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* 口径提示：不参与收益计算 */}
      <p className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          分红为独立记录，不计入出入金现金流、不参与 XIRR 与净值计算；红利再投的现金价值已体现在持仓市值中。
        </span>
      </p>

      {/* 标的：证券搜索选择（对齐「录入买卖」样式/逻辑，§10，不再用原生下拉） */}
      <div className="space-y-1.5">
        <Label htmlFor="income-security">标的 *</Label>
        <SecuritySearchCombobox
          id="income-security"
          value={selectedSecurityLabel}
          placeholder={secLoading ? '加载中…' : '搜索代码 / 名称 / 拼音首字母'}
          disabled={secLoading && !securityId}
          onSelect={handleSelectMaster}
        />
        {errors.securityId && (
          <p className="text-xs text-destructive">{errors.securityId.message}</p>
        )}
      </div>

      {/* 日期 */}
      <div className="space-y-1.5">
        <Label htmlFor="income-date">日期 *</Label>
        <Input id="income-date" type="date" {...register('date')} />
        {errors.date && (
          <p className="text-xs text-destructive">{errors.date.message}</p>
        )}
      </div>

      {/* 类型（编辑态可改 type；录入态固定现金分红，I-02） */}
      {isEdit && record ? (
        <div className="space-y-1.5">
          <Label htmlFor="income-type">类型</Label>
          <Select
            value={dividendType ?? DividendType.CASH}
            onValueChange={(v) =>
              setValue('type', v as DividendType, { shouldValidate: true })
            }
          >
            <SelectTrigger id="income-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DividendType.CASH}>
                {DIVIDEND_TYPE_LABEL.CASH}
              </SelectItem>
              <SelectItem value={DividendType.STOCK_DIVIDEND}>
                {DIVIDEND_TYPE_LABEL.STOCK_DIVIDEND}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label>类型</Label>
          <p className="rounded-md border border-input px-3 py-2 text-sm text-muted-foreground">
            现金分红（红利再投不录入）
          </p>
        </div>
      )}

      {/* 金额（分红 = 税前） */}
      <div className="space-y-1.5">
        <Label htmlFor="income-amount">分红额（税前）*</Label>
        <Input
          id="income-amount"
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          {...register('amount')}
        />
        {errors.amount && (
          <p className="text-xs text-destructive">{errors.amount.message}</p>
        )}
      </div>

      {/* 所得税（I-02：标签改「（可选）」） */}
      <div className="space-y-1.5">
        <Label htmlFor="income-tax">所得税（可选）</Label>
        <Input
          id="income-tax"
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          {...register('tax')}
        />
        {errors.tax && (
          <p className="text-xs text-destructive">{errors.tax.message}</p>
        )}
      </div>

      {/* 净额实时展示 */}
      <div className="space-y-1.5">
        <Label>净额（自动）</Label>
        <div
          className={`rounded-md border px-3 py-2 text-sm tabular-nums ${
            netAmount !== null && Number(netAmount) < 0
              ? 'border-destructive/60 bg-destructive/5 text-destructive'
              : 'bg-muted/40 text-foreground'
          }`}
          data-testid="dividend-net-amount"
        >
          {netAmount !== null ? (
            formatCurrency(Number(netAmount), 2)
          ) : (
            <span className="text-muted-foreground">
              填写分红额与所得税后自动计算
            </span>
          )}
        </div>
      </div>

      {/* 备注 */}
      <div className="space-y-1.5">
        <Label htmlFor="income-note">备注</Label>
        <Textarea id="income-note" rows={2} {...register('note')} />
        {errors.note && (
          <p className="text-xs text-destructive">{errors.note.message}</p>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          保存
        </Button>
      </div>
    </form>
  );
}
