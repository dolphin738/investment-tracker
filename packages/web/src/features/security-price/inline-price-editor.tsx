/**
 * features/security-price/inline-price-editor.tsx — 持仓页现价内联编辑
 *
 * PRD §7.2【B】：持仓列表只读，但「现价」支持内联编辑（调 security-price API）。
 * 点击现价进入输入态，回车/失焦保存，Esc 取消，保存后触发后端重算。
 */

import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Pencil, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useUpsertSecurityPrice } from '@/hooks/use-security-prices';
import { toIsoDate } from '@/lib/constants';
import { formatCurrency } from '@/lib/utils';

export interface InlinePriceEditorProps {
  portfolioId: string;
  securityId: string;
  /** 当前现价（number，来自持仓推导） */
  value: number;
  /** 现价日期（用于展示估值标识） */
  priceAsOf?: string | null;
  /** 估值标识：COST_BASED 表示无现价记录 */
  flag?: string;
  className?: string;
}

export function InlinePriceEditor({
  portfolioId,
  securityId,
  value,
  priceAsOf,
  flag,
  className,
}: InlinePriceEditorProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const upsertMutation = useUpsertSecurityPrice();

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = () => {
    setDraft(String(value));
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setDraft('');
  };

  const save = () => {
    const price = Number(draft);
    if (!draft || !Number.isFinite(price) || price <= 0) {
      cancel();
      return;
    }
    upsertMutation.mutate(
      {
        portfolioId,
        payload: {
          securityId,
          asOf: toIsoDate(new Date()),
          price,
        },
      },
      {
        onSettled: () => {
          setEditing(false);
          setDraft('');
        },
      },
    );
  };

  if (editing) {
    return (
      <div className={className}>
        <div className="flex items-center gap-1">
          <Input
            ref={inputRef}
            type="number"
            step="0.000001"
            min="0"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') cancel();
            }}
            onBlur={save}
            className="h-7 w-24 px-2 text-right text-sm tabular-nums"
          />
          {upsertMutation.isPending && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
          <button
            type="button"
            onClick={save}
            disabled={upsertMutation.isPending}
            className="text-green-600 hover:text-green-700"
            aria-label="保存价格"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={upsertMutation.isPending}
            className="text-muted-foreground hover:text-foreground"
            aria-label="取消"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={startEdit}
        title={
          flag === 'COST_BASED' || !priceAsOf
            ? '暂无现价记录，当前按成本估值，点击录入现价'
            : `现价日期 ${priceAsOf}，点击修改`
        }
        className="group inline-flex items-center gap-1 rounded px-1 py-0.5 text-right font-mono tabular-nums hover:bg-accent"
      >
        ¥{formatCurrency(value)}
        <Pencil className="h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    </div>
  );
}
