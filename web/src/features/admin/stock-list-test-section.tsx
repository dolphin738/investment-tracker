/**
 * features/admin/stock-list-test-section.tsx — 「股票列表和测试」分页（§1–§6）
 *
 * 左右两栏（lg:grid-cols-2）：
 * - 左 StockListPanel：只读系统级证券主数据（GET /api/admin/securities/masters），
 *   关键字搜索（code/name/拼音首字母）+ 分页浏览；每行「填入测试」把 code 注入右栏。
 * - 右 InterfaceTestPanel：选接口 → 编辑参数 → 可选 codes → 执行测试
 *   （POST /api/admin/quote-interfaces/{id}/test）→ 展示原始响应 + 解析结果。
 *
 * 组件组织对齐 quote-provider-section.tsx：本文件内含主组件 + 两个面板子组件。
 */

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Loader2, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useIsAdmin } from '@/stores/auth.store';
import { useSecurityMasters, useSyncSecurityMasters } from '@/hooks/use-security-master';
import { useQuoteInterfacesAll } from '@/hooks/use-quote-interface';
import { useQuoteProviders } from '@/hooks/use-quote-provider';
import { useInterfaceTest } from '@/hooks/use-interface-test';
import type { SecurityMaster } from '@/api/security-master.api';
import type { InterfaceTestResponse, QuoteInterface } from '@/api/quote-interface.api';

const PAGE_SIZE = 20;

export function StockListTestSection(): JSX.Element {
  // 左右联动：左栏「填入测试」追加 code 到右栏 codesText
  const [codesText, setCodesText] = useState('');

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <StockListPanel
        onPickCode={(code) =>
          setCodesText((prev) => (prev ? `${prev},${code}` : code))
        }
      />
      <InterfaceTestPanel codesText={codesText} onCodesChange={setCodesText} />
    </div>
  );
}

/** 左栏：系统级证券主数据（只读、搜索、分页） */
function StockListPanel({
  onPickCode,
}: {
  onPickCode: (code: string) => void;
}): JSX.Element {
  const isAdmin = useIsAdmin();
  const [page, setPage] = useState(1);
  const [rawQ, setRawQ] = useState('');
  const [q, setQ] = useState('');

  // 搜索防抖 300ms
  useEffect(() => {
    const t = setTimeout(() => setQ(rawQ.trim()), 300);
    return () => clearTimeout(t);
  }, [rawQ]);

  // 搜索词变化重置到第一页
  useEffect(() => {
    setPage(1);
  }, [q]);

  const { data, isLoading, isError } = useSecurityMasters({
    page,
    pageSize: PAGE_SIZE,
    q,
  });
  const syncMut = useSyncSecurityMasters();

  const items: SecurityMaster[] = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">证券主数据</CardTitle>
            <CardDescription>
              系统级全市场证券字典（由已配置接口定时同步；此处仅只读浏览）
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => syncMut.mutate()}
            disabled={!isAdmin || syncMut.isPending}
          >
            <RefreshCw
              className={cn('mr-1 h-3.5 w-3.5', syncMut.isPending && 'animate-spin')}
            />
            同步
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          placeholder="搜索代码 / 名称 / 拼音首字母"
          value={rawQ}
          onChange={(e) => setRawQ(e.target.value)}
        />

        {isLoading && (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
          </div>
        )}
        {isError && (
          <p className="py-8 text-center text-sm text-red-500">
            加载失败，请刷新重试
          </p>
        )}
        {!isLoading && !isError && items.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            暂无主数据，点击右上角「同步」拉取
          </p>
        )}

        {!isLoading && !isError && items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">代码</TableHead>
                <TableHead>名称</TableHead>
                <TableHead className="w-14">市场</TableHead>
                <TableHead className="w-20">类型</TableHead>
                <TableHead className="w-16 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono">{s.code}</TableCell>
                  <TableCell className="truncate">{s.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.exchange ?? '-'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.type ?? '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onPickCode(s.code)}
                      title="填入右侧测试"
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* 分页器 */}
        <div className="flex items-center justify-between pt-2 text-sm text-muted-foreground">
          <span>共 {total} 条</span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <span>
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一页
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface ParamRow {
  key: string;
  value: string;
  /** 模板默认值：仅作输入框占位提示，不实际填入（§实现：默认值以 placeholder 展示） */
  defaultValue: string;
}

/** 右栏：单接口测试（选接口 → 编辑参数 → 执行 → 看原始响应 + 解析） */
function InterfaceTestPanel({
  codesText,
  onCodesChange,
}: {
  codesText: string;
  onCodesChange: (v: string) => void;
}): JSX.Element {
  const { data: interfaces } = useQuoteInterfacesAll();
  const { data: providers } = useQuoteProviders();
  const testMut = useInterfaceTest();

  // 提供方 id → 名称：接口下拉展示接口归属（如「A股行情（小熊同学）」）
  const providerNameById = useMemo(() => {
    const m = new Map<string, string>();
    (providers ?? []).forEach((p) => m.set(p.id, p.name));
    return m;
  }, [providers]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paramRows, setParamRows] = useState<ParamRow[]>([]);
  const [result, setResult] = useState<InterfaceTestResponse | null>(null);

  const enabledInterfaces: QuoteInterface[] = (interfaces ?? []).filter(
    (i) => i.enabled,
  );

  // 切换接口时以其 params 模板初始化可编辑行
  useEffect(() => {
    if (!selectedId) {
      setParamRows([]);
      return;
    }
    const itf = (interfaces ?? []).find((i) => i.id === selectedId);
    const params = (itf?.params ?? {}) as Record<string, unknown>;
    setParamRows(
      Object.entries(params).map(([k, v]) => ({
        key: k,
        value: '',
        defaultValue: v == null ? '' : String(v),
      })),
    );
  }, [selectedId, interfaces]);

  const updateRow = (idx: number, patch: Partial<ParamRow>) =>
    setParamRows((rows) =>
      rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  const addRow = () =>
    setParamRows((rows) => [...rows, { key: '', value: '', defaultValue: '' }]);
  const removeRow = (idx: number) =>
    setParamRows((rows) => rows.filter((_, i) => i !== idx));

  const handleTest = () => {
    if (!selectedId) return;
    const params: Record<string, unknown> = {};
    paramRows.forEach((r) => {
      const k = r.key.trim();
      if (k) params[k] = r.value.trim() !== '' ? r.value : r.defaultValue;
    });
    const codes = codesText
      .split(/[\s,，]+/)
      .map((c) => c.trim())
      .filter(Boolean);
    setResult(null);
    testMut.mutate(
      { interfaceId: selectedId, params, codes: codes.length ? codes : undefined },
      { onSuccess: (data) => setResult(data) },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">接口测试</CardTitle>
        <CardDescription>
          选择接口 → 编辑参数 → 执行 → 查看原始响应与解析结果（不持久化）
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">接口</label>
          <Select
            value={selectedId ?? undefined}
            onValueChange={(v) => setSelectedId(v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="选择要测试的接口（仅启用）" />
            </SelectTrigger>
            <SelectContent>
              {enabledInterfaces.map((it) => (
                <SelectItem key={it.id} value={it.id}>
                  {it.name}（{providerNameById.get(it.provider_id) ?? '未知提供方'}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* 参数：可编辑键值对（支持增删） */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">参数</label>
            <Button variant="ghost" size="sm" onClick={addRow}>
              <Plus className="mr-1 h-3.5 w-3.5" /> 添加参数
            </Button>
          </div>
          {paramRows.length === 0 && (
            <p className="text-xs text-muted-foreground">该接口无默认参数模板</p>
          )}
          <div className="space-y-2">
            {paramRows.map((row, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  className="w-2/5"
                  placeholder="参数名"
                  value={row.key}
                  onChange={(e) => updateRow(idx, { key: e.target.value })}
                />
                <Input
                  className="flex-1"
                  placeholder={row.defaultValue ? `默认：${row.defaultValue}` : '参数值'}
                  value={row.value}
                  onChange={(e) => updateRow(idx, { value: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeRow(idx)}
                  aria-label="删除参数"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        {/* codes（可选） */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            代码（可选，逗号 / 空格 / 换行分隔）
          </label>
          <Textarea
            placeholder="如 600519,000001"
            value={codesText}
            onChange={(e) => onCodesChange(e.target.value)}
            rows={2}
          />
        </div>

        <Button
          onClick={handleTest}
          disabled={!selectedId || testMut.isPending}
        >
          <Play
            className={cn('mr-2 h-4 w-4', testMut.isPending && 'animate-spin')}
          />
          {testMut.isPending ? '测试中…' : '执行测试'}
        </Button>

        {/* 结果展示 */}
        {result && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Badge
                variant={result.status === 'success' ? 'success' : 'secondary'}
              >
                {result.status === 'success' ? '成功' : '失败'}
              </Badge>
              <span className="text-muted-foreground">
                耗时 {result.elapsedMs}ms
              </span>
              {result.httpStatus != null && (
                <span className="text-muted-foreground">
                  HTTP {result.httpStatus}
                </span>
              )}
            </div>

            {result.error && (
              <p className="text-sm text-red-500">{result.error}</p>
            )}

            {result.parsed && Object.keys(result.parsed).length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  解析结果（代码 → 价格）
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-1/2">代码</TableHead>
                      <TableHead>价格</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {Object.entries(result.parsed).map(([code, price]) => (
                      <TableRow key={code}>
                        <TableCell className="font-mono">{code}</TableCell>
                        <TableCell>{price}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                原始响应
              </div>
              <Textarea
                readOnly
                value={safeStringify(result.raw)}
                rows={8}
                className="font-mono text-xs"
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 未知结构安全序列化（避免循环引用等导致 JSON.stringify 抛错） */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
