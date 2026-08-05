/**
 * features/security-income/dividend-fee-form.tsx — 分红 / 费用录入表单（HOLD-B-P0-10）
 *
 * PRD §7.2【E】：
 * - 分红：日期 / 标的 / 金额 / 类型（现金分红·红利再投）/ 备注
 * - 费用：日期 / 标的 / 金额 / 费用类型（佣金·印花税·其他）/ 关联流水 ID（可选）/ 备注
 *
 * ⚠️ PRD 验收 3：**红利再投不录入**（无现金进出，其价值已体现在持仓市值上升中），
 *    故分红表单不提供 STOCK_DIVIDEND 选项，固定以 CASH 提交；
 *    历史数据若存在 STOCK_DIVIDEND，列表仍可正常展示。
 * ⚠️ D-02 / D-03：两者均不进现金流、不触发重算。
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Info, Loader2 } from 'lucide-react';
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
import { useSecurities } from '@/hooks/use-securities';
import { useCreateDividend } from '@/hooks/use-dividends';
import { useCreateFee } from '@/hooks/use-fees';
import { toIsoDate } from '@/lib/constants';
import { DividendType, FeeType } from '@/api/types';

/** 记录种类 */
export type IncomeRecordKind = 'dividend' | 'fee';

/** 费用类型中文映射（导出供列表复用，避免两处硬编码漂移） */
export const FEE_TYPE_LABEL: Record<string, string> = {
  COMMISSION: '佣金',
  STAMP_TAX: '印花税',
  OTHER: '其他',
};

/** 分红类型中文映射（导出供列表复用） */
export const DIVIDEND_TYPE_LABEL: Record<string, string> = {
  CASH: '现金分红',
  STOCK_DIVIDEND: '红利再投',
};

/** 金额：> 0 且最多 2 位小数（PRD §8.1 NUMERIC(18,2)） */
const amountSchema = z
  .string()
  .min(1, '请输入金额')
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), '金额最多 2 位小数')
  .refine((v) => Number(v) > 0, '金额必须大于 0');

const recordSchema = z.object({
  securityId: z.string().min(1, '请选择标的'),
  date: z
    .string()
    .min(1, '请选择日期')
    .refine((v) => v <= toIsoDate(new Date()), '日期不能为未来'),
  amount: amountSchema,
  feeType: z.nativeEnum(FeeType).optional(),
  note: z.string().max(200, '备注最多 200 字').optional(),
});

type RecordFormValues = z.infer<typeof recordSchema>;

export interface DividendFeeFormProps {
  portfolioId: string;
  /** 表单种类：分红 / 费用 */
  kind: IncomeRecordKind;
  /** 提交成功后回调（关闭弹窗） */
  onSuccess?: () => void;
}

export function DividendFeeForm({
  portfolioId,
  kind,
  onSuccess,
}: DividendFeeFormProps): JSX.Element {
  const isDividend = kind === 'dividend';
  const { data: securities = [], isLoading: secLoading } =
    useSecurities(portfolioId);
  const createDividend = useCreateDividend(portfolioId);
  const createFee = useCreateFee(portfolioId);
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
      securityId: '',
      date: toIsoDate(new Date()),
      amount: '',
      feeType: FeeType.OTHER,
      note: '',
    },
  });

  const securityId = watch('securityId');
  const feeType = watch('feeType');

  const onSubmit = async (values: RecordFormValues): Promise<void> => {
    setSubmitting(true);
    try {
      if (isDividend) {
        await createDividend.mutateAsync({
          securityId: values.securityId,
          date: values.date,
          amount: values.amount,
          // 红利再投不录入（PRD 验收 3），固定现金分红
          type: DividendType.CASH,
          note: values.note || undefined,
        });
      } else {
        await createFee.mutateAsync({
          securityId: values.securityId,
          date: values.date,
          amount: values.amount,
          type: values.feeType ?? FeeType.OTHER,
          note: values.note || undefined,
        });
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
          {isDividend
            ? '分红为独立记录，不计入出入金现金流、不参与 XIRR 与净值计算；红利再投无需录入，其价值已体现在持仓市值中。'
            : '此处费用为独立记录，不参与 XIRR 与净值计算；买卖手续费请在「录入买卖」的费用字段填写（计入持仓成本）。'}
        </span>
      </p>

      {/* 标的 */}
      <div className="space-y-1.5">
        <Label htmlFor="income-security">标的 *</Label>
        <Select
          value={securityId}
          onValueChange={(v) =>
            setValue('securityId', v, { shouldValidate: true })
          }
          disabled={secLoading}
        >
          <SelectTrigger id="income-security">
            <SelectValue
              placeholder={secLoading ? '加载中…' : '请选择标的'}
            />
          </SelectTrigger>
          <SelectContent>
            {securities.map((sec) => (
              <SelectItem key={sec.id} value={sec.id}>
                {sec.name}（{sec.code}）
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.securityId && (
          <p className="text-xs text-destructive">{errors.securityId.message}</p>
        )}
        {!secLoading && securities.length === 0 && (
          <p className="text-xs text-muted-foreground">
            当前组合还没有标的，请先在「录入买卖」中新建标的
          </p>
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

      {/* 类型 */}
      {isDividend ? (
        <div className="space-y-1.5">
          <Label>类型</Label>
          <p className="rounded-md border border-input px-3 py-2 text-sm text-muted-foreground">
            现金分红（红利再投不录入）
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="income-fee-type">费用类型 *</Label>
          <Select
            value={feeType ?? FeeType.OTHER}
            onValueChange={(v) =>
              setValue('feeType', v as FeeType, { shouldValidate: true })
            }
          >
            <SelectTrigger id="income-fee-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={FeeType.COMMISSION}>
                {FEE_TYPE_LABEL.COMMISSION}
              </SelectItem>
              <SelectItem value={FeeType.STAMP_TAX}>
                {FEE_TYPE_LABEL.STAMP_TAX}
              </SelectItem>
              <SelectItem value={FeeType.OTHER}>
                {FEE_TYPE_LABEL.OTHER}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* 金额 */}
      <div className="space-y-1.5">
        <Label htmlFor="income-amount">
          {isDividend ? '分红金额 *' : '费用金额 *'}
        </Label>
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
