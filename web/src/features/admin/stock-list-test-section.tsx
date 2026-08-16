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

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { SECURITY_TYPE_LABELS, securityTypeLabel, EXCHANGE_LABELS } from '@/lib/types';
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
import { SearchInput } from '@/components/ui/search-input';
import { Textarea } from '@/components/ui/textarea';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useIsAdmin } from '@/stores/auth.store';
import {
  useDeleteSecurityMasters,
  useSecurityMasterStats,
  useSecurityMasters,
  useSyncSecurityMasters,
} from '@/hooks/use-security-master';
import { useQuoteInterfacesAll } from '@/hooks/use-quote-interface';
import { useQuoteProviders } from '@/hooks/use-quote-provider';
import { useInterfaceTest } from '@/hooks/use-interface-test';
import type { SecurityMaster, SecurityMasterDeleteParams, UsedInterfaceInfo } from '@/api/security-master.api';
import type { InterfaceTestResponse, QuoteInterface } from '@/api/quote-interface.api';

const PAGE_SIZE = 20;

/** 「本次同步来源」持久化键：组件重挂载后从 localStorage 读取，下次同步成功再覆盖 */
const SYNC_SOURCE_KEY = 'invest:master-sync-source';

function readStoredUsed(): UsedInterfaceInfo[] | null {
  try {
    const raw = localStorage.getItem(SYNC_SOURCE_KEY);
    return raw ? (JSON.parse(raw) as UsedInterfaceInfo[]) : null;
  } catch {
    return null;
  }
}

export function StockListTestSection(): JSX.Element {
  // 左右联动：左栏「填入测试」追加 code 到右栏 codesText
  const [codesText, setCodesText] = useState('');

  // 同步逻辑上提：左栏同步按钮与右侧统计块共享「本次同步来源」
  const syncMut = useSyncSecurityMasters();
  const [lastUsed, setLastUsed] = useState<UsedInterfaceInfo[] | null>(
    () => readStoredUsed(),
  );
  const usedSources =
    syncMut.data?.used && syncMut.data.used.length > 0
      ? syncMut.data.used
      : lastUsed;
  const handleSync = () =>
    syncMut.mutate(undefined, {
      onSuccess: (data) => {
        if (data.used && data.used.length > 0) {
          setLastUsed(data.used);
          try {
            localStorage.setItem(SYNC_SOURCE_KEY, JSON.stringify(data.used));
          } catch {
            /* 忽略持久化失败（隐私模式 / 配额） */
          }
        }
      },
    });

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <StockListPanel
        onPickCode={(code) =>
          setCodesText((prev) => (prev ? `${prev},${code}` : code))
        }
        onSync={handleSync}
        syncPending={syncMut.isPending}
      />
      <div className="space-y-6">
        <MasterStatsPanel usedSources={usedSources} />
        <InterfaceTestPanel codesText={codesText} onCodesChange={setCodesText} />
      </div>
    </div>
  );
}

/** 交易所字母大写：仅把代码开头的字母前缀（sh/sz/hk/us 等）转为大写，数字与后缀不动。
 * 仅作用于展示；填入右侧测试仍使用原始 code（保持交易所小写，避免破坏上游请求）。 */
function formatExchangeCode(code: string): string {
  const m = code.match(/^[a-zA-Z]+/);
  if (!m) return code;
  return code.slice(0, m[0].length).toUpperCase() + code.slice(m[0].length);
}

/** 原生 checkbox（风格对齐 settings.tsx 的 PrefCheckbox，零新依赖）。 */
function RowCheckbox({
  checked,
  onCheckedChange,
  disabled,
  indeterminate,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  indeterminate?: boolean;
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  // 部分选中（非全选、非全空）时显示横杠半选态：indeterminate 非受控属性，需直设 DOM
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="h-4 w-4 rounded border-input accent-primary"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  );
}

/** 左栏：系统级证券主数据（只读、搜索、分页、类别筛选、批量/单行删除） */
export function StockListPanel({
  onPickCode,
  onSync,
  syncPending,
}: {
  onPickCode: (code: string) => void;
  onSync: () => void;
  syncPending: boolean;
}): JSX.Element {
  const isAdmin = useIsAdmin();
  // 删除（批量/单行）：仅管理员可用；删除权限与同步一致（require_admin）
  const deleteMut = useDeleteSecurityMasters();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmPayload, setConfirmPayload] = useState<SecurityMasterDeleteParams | null>(null);
  const [selectAll, setSelectAll] = useState(false);
  // 跨页选择：记录哪些页存在已选行（用于「已选 X 条（跨 Y 页）」提示与合并模式）
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());

  const openBatchDelete = () => {
    if (selectAll) {
      setConfirmPayload({
        all: true,
        q,
        assetClass: assetClass ?? undefined,
        exchange: exchange ?? undefined,
      });
    } else if (selectedIds.size > 0) {
      setConfirmPayload({ ids: Array.from(selectedIds) });
    } else {
      return;
    }
    setConfirmOpen(true);
  };
  const openSingleDelete = (s: SecurityMaster) => {
    setConfirmPayload({ ids: [s.id] });
    setConfirmOpen(true);
  };
  const handleConfirmDelete = () => {
    if (!confirmPayload) return;
    deleteMut.mutate(confirmPayload, {
      onSuccess: (data) => {
        toast.success(`已删除 ${data.deleted} 条`);
        if (data.skipped.length > 0) {
          toast.warning(`${data.skipped.length} 条被引用或不存在，已跳过`);
        }
        setSelectedIds(new Set());
        setSelectAll(false);
        setSelectedPages(new Set());
        setConfirmOpen(false);
      },
      onError: () => setConfirmOpen(false),
    });
  };

  const [page, setPage] = useState(1);
  const [rawQ, setRawQ] = useState('');
  const [q, setQ] = useState('');
  const [assetClass, setAssetClass] = useState<string | null>(null);
  const [exchange, setExchange] = useState<string | null>(null);
  const [jumpInput, setJumpInput] = useState('');

  // 搜索防抖 300ms
  useEffect(() => {
    const t = setTimeout(() => setQ(rawQ.trim()), 300);
    return () => clearTimeout(t);
  }, [rawQ]);

  // 搜索词 / 类别 / 交易所筛选变化：重置到第一页并清空本地面板选择
  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
    setSelectAll(false);
    setSelectedPages(new Set());
  }, [q, assetClass, exchange]);

  const { data, isLoading, isError } = useSecurityMasters({
    page,
    pageSize: PAGE_SIZE,
    q,
    assetClass: assetClass ?? undefined,
    exchange: exchange ?? undefined,
  });

  const items: SecurityMaster[] = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 当前页已选行数（用于表头 checkbox 三态：全选 / 半选 / 未选）
  const pageSelectedCount = items.filter((s) => selectedIds.has(s.id)).length;
  const allPageSelected = items.length > 0 && pageSelectedCount === items.length;
  const somePageSelected = pageSelectedCount > 0 && pageSelectedCount < items.length;

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
            variant="default"
            onClick={onSync}
            disabled={!isAdmin || syncPending}
          >
            <RefreshCw
              className={cn('mr-1 h-3.5 w-3.5', syncPending && 'animate-spin')}
            />
            同步
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-[200px] flex-1">
            <SearchInput
              placeholder="搜索代码 / 名称 / 拼音首字母"
              value={rawQ}
              onChange={(e) => setRawQ(e.target.value)}
              onClear={() => setRawQ('')}
            />
          </div>
          <Select
            value={assetClass ?? '__all__'}
            onValueChange={(v) => setAssetClass(v === '__all__' ? null : v)}
          >
            <SelectTrigger className="w-36 shrink-0">
              <SelectValue placeholder="全部类别" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部类别</SelectItem>
              {Object.entries(SECURITY_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={exchange ?? '__all__'}
            onValueChange={(v) => setExchange(v === '__all__' ? null : v)}
          >
            <SelectTrigger className="w-28 shrink-0">
              <SelectValue placeholder="全部市场" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部市场</SelectItem>
              {Object.entries(EXCHANGE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isAdmin && (
              <Button
                variant="outline"
                size="sm"
                onClick={openBatchDelete}
                disabled={!selectAll && selectedIds.size === 0}
                data-testid="batch-delete"
                className="shrink-0 text-red-600 hover:text-red-700"
              >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              删除({selectAll ? total : selectedIds.size})
            </Button>
          )}
          {isAdmin && !selectAll && total > PAGE_SIZE && (
            <Button
              variant="link"
              size="sm"
              onClick={() => setSelectAll(true)}
              data-testid="select-all-pages"
              className="shrink-0 px-0 text-muted-foreground"
            >
              全选全部 {total} 条（跨页）
            </Button>
          )}
          {!selectAll && selectedIds.size > 0 && (
            <span
              data-testid="selection-summary"
              className="shrink-0 text-xs text-muted-foreground"
            >
              已选 {selectedIds.size} 条
              {selectedPages.size > 1 ? `（跨 ${selectedPages.size} 页）` : ''}
            </span>
          )}
        </div>

        {selectAll && (
          <div className="flex items-center justify-between rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm">
            <span>已全选全部 {total} 条主数据（跨所有页）</span>
            <Button
              variant="link"
              size="sm"
              onClick={() => setSelectAll(false)}
              data-testid="clear-select-all"
              className="px-0"
            >
              取消全选
            </Button>
          </div>
        )}

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
                <TableHead className="w-12">
                  <RowCheckbox
                    checked={selectAll || allPageSelected}
                    indeterminate={!selectAll && somePageSelected}
                    onCheckedChange={(v) => {
                      if (selectAll) {
                        setSelectAll(false);
                        return;
                      }
                      // 合并模式：仅在当前页范围内增删，不影响其它页已选
                      setSelectedIds((prev) => {
                        const n = new Set(prev);
                        if (v) items.forEach((s) => n.add(s.id));
                        else items.forEach((s) => n.delete(s.id));
                        return n;
                      });
                      setSelectedPages((prev) => {
                        const n = new Set(prev);
                        if (v) n.add(page);
                        else n.delete(page);
                        return n;
                      });
                    }}
                  />
                </TableHead>
                <TableHead className="w-12">#</TableHead>
                <TableHead className="w-28">代码</TableHead>
                <TableHead>名称</TableHead>
                <TableHead className="w-20">类别</TableHead>
                <TableHead className="w-16 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((s, index) => (
                <TableRow
                  key={s.id}
                  className={cn(
                    (selectAll || selectedIds.has(s.id)) && 'bg-muted/40',
                  )}
                >
                  <TableCell>
                    <RowCheckbox
                      checked={selectAll || selectedIds.has(s.id)}
                      disabled={selectAll}
                      onCheckedChange={(v) => {
                        setSelectedIds((prev) => {
                          const n = new Set(prev);
                          if (v) n.add(s.id);
                          else n.delete(s.id);
                          return n;
                        });
                        // 同步记录该行所属页：勾选则登记，取消时仅当本页无其它已选才移除
                        setSelectedPages((prevPages) => {
                          if (v) {
                            const n = new Set(prevPages);
                            n.add(page);
                            return n;
                          }
                          const stillOnPage = items.some(
                            (it) => it.id !== s.id && selectedIds.has(it.id),
                          );
                          if (stillOnPage) return prevPages;
                          const n = new Set(prevPages);
                          n.delete(page);
                          return n;
                        });
                      }}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                  <TableCell className="font-mono">{formatExchangeCode(s.code)}</TableCell>
                  <TableCell className="truncate">{s.name}</TableCell>
                  <TableCell>{securityTypeLabel(s.assetClass)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onPickCode(s.code)}
                        title="填入右侧测试"
                      >
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                      {isAdmin && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openSingleDelete(s)}
                          title="删除"
                          className="text-red-600 hover:text-red-700"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* 删除确认弹窗（批量/单行共用） */}
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除证券主数据</AlertDialogTitle>
              <AlertDialogDescription>
                {confirmPayload?.all
                  ? `将删除全部 ${total} 条证券主数据（跨所有页，应用当前筛选条件）；其中被组合持仓引用的会被跳过。`
                  : `将删除 ${confirmPayload?.ids?.length ?? 0} 条证券主数据；其中被组合持仓引用的会被跳过。`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteMut.isPending}>
                取消
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleConfirmDelete}
                disabled={deleteMut.isPending}
                data-testid="confirm-delete"
                className="bg-red-600 hover:bg-red-700"
              >
                {deleteMut.isPending ? '删除中…' : '删除'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* 分页器 */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 text-sm text-muted-foreground">
          <span>共 {total} 条</span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(1)}
            >
              首页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <span className="px-1">
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
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(totalPages)}
            >
              末页
            </Button>
            <div className="flex items-center gap-1">
              <span className="text-xs">跳至</span>
              <Input
                type="number"
                min={1}
                max={totalPages}
                value={jumpInput}
                onChange={(e) => setJumpInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const n = Number(jumpInput);
                    if (jumpInput !== '' && Number.isFinite(n)) {
                      setPage(Math.min(totalPages, Math.max(1, Math.floor(n))));
                    }
                    setJumpInput('');
                  }
                }}
                onBlur={() => {
                  const n = Number(jumpInput);
                  if (jumpInput !== '' && Number.isFinite(n)) {
                    setPage(Math.min(totalPages, Math.max(1, Math.floor(n))));
                  }
                  setJumpInput('');
                }}
                className="h-7 w-16 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                placeholder="页"
              />
              <span className="text-xs">页</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** 证券主数据统计块：本次同步接口名 + 每接口获取条数 + 主数据按类别分布 */
function MasterStatsPanel({
  usedSources,
}: {
  usedSources: UsedInterfaceInfo[] | null;
}): JSX.Element {
  const { data: stats } = useSecurityMasterStats();
  const counts = stats?.counts ?? {};
  const categoryRows = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">证券主数据统计</CardTitle>
        <CardDescription>本次同步来源与主数据按类别分布</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {/* 左：主数据按类别 */}
          <div>
            <div className="mb-1.5 text-sm font-medium">主数据按类别</div>
            {categoryRows.length > 0 ? (
              <ul className="space-y-1">
                {categoryRows.map(([ac, cnt]) => (
                  <li
                    key={ac}
                    className="flex items-center justify-between gap-2 border-b border-border/50 py-1 text-sm last:border-0"
                  >
                    <span className="truncate text-foreground/90">
                      {securityTypeLabel(ac)}
                    </span>
                    <span className="shrink-0 text-muted-foreground">{cnt} 条</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">暂无主数据</p>
            )}
          </div>

          {/* 右：本次同步来源 */}
          <div>
            <div className="mb-1.5 text-sm font-medium">本次同步来源</div>
            {usedSources && usedSources.length > 0 ? (
              <ul className="space-y-1">
                {usedSources.map((u) => (
                  <li
                    key={u.interfaceId}
                    className="flex items-center justify-between gap-2 border-b border-border/50 py-1 text-sm last:border-0"
                  >
                    <span
                      className="truncate text-foreground/90"
                      title={`${u.providerName} · ${u.interfaceName}`}
                    >
                      {u.providerName} · {u.interfaceName}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {typeof u.fetched === 'number' ? `${u.fetched} 条` : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">暂无同步记录</p>
            )}
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

/** 识别接口参数模板里的占位符默认值（如 string / 示例 / example），留空时不作为真实参数发送 */
function isPlaceholderValue(v: string): boolean {
  const s = v.trim().toLowerCase();
  return ['string', '示例', 'example', '占位', '占位符', 'placeholder', 'xxx'].includes(s);
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

  // —— 原始响应：全部复制 + 查找高亮/跳转 ——
  const [findQuery, setFindQuery] = useState('');
  const [currentMatch, setCurrentMatch] = useState(0);
  const rawPreRef = useRef<HTMLPreElement>(null);

  const rawText = result ? safeStringify(result.raw) : '';

  /** 查询词在 rawText 中全部命中位置（大小写不敏感） */
  const matchIndices = useMemo(() => {
    if (!findQuery) return [];
    const q = findQuery.toLowerCase();
    const idxs: number[] = [];
    let i = rawText.toLowerCase().indexOf(q);
    while (i !== -1) {
      idxs.push(i);
      i = rawText.toLowerCase().indexOf(q, i + q.length);
    }
    return idxs;
  }, [rawText, findQuery]);

  /** 高亮当前命中并滚动到可视区（mark 元素顺序即命中顺序） */
  useEffect(() => {
    if (!findQuery || matchIndices.length === 0) return;
    const marks = rawPreRef.current?.querySelectorAll('mark') ?? [];
    const target = marks[Math.min(currentMatch, matchIndices.length - 1)];
    target?.scrollIntoView({ block: 'center' });
  }, [findQuery, currentMatch, matchIndices.length]);

  const jumpMatch = (dir: 1 | -1): void => {
    if (matchIndices.length === 0) return;
    setCurrentMatch((m) => (m + dir + matchIndices.length) % matchIndices.length);
  };

  const handleCopyAll = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(rawText);
      toast.success('原始响应已复制');
    } catch {
      toast.error('复制失败，请手动选择复制');
    }
  };

  // 与后端选源 AND 逻辑一致：接口启用 AND 所属提供方启用（provider.enabled 为父级总闸）。
  const enabledInterfaces: QuoteInterface[] = (interfaces ?? []).filter((i) => {
    const provider = (providers ?? []).find((p) => p.id === i.provider_id);
    return i.enabled && (provider?.enabled ?? false);
  });

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
    setFindQuery('');
    setCurrentMatch(0);
    const params: Record<string, unknown> = {};
    paramRows.forEach((r) => {
      const k = r.key.trim();
      if (!k) return;
      const candidate = r.value.trim() !== '' ? r.value.trim() : (r.defaultValue ?? '').trim();
      // 空值或模板占位符（如 string / 示例）不发送，避免把上游过滤成空列表
      if (!candidate || isPlaceholderValue(candidate)) return;
      params[k] = candidate;
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
                  placeholder={
                    row.defaultValue
                      ? isPlaceholderValue(row.defaultValue)
                        ? `示例值（留空不发送）：${row.defaultValue}`
                        : `默认：${row.defaultValue}`
                      : '参数值'
                  }
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
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  原始响应（{rawText.length.toLocaleString()} 字符）
                </span>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 rounded-md border px-2 py-1">
                    <Search className="h-3.5 w-3.5 text-muted-foreground" />
                    <input
                      type="text"
                      value={findQuery}
                      onChange={(e) => {
                        setFindQuery(e.target.value);
                        setCurrentMatch(0);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          jumpMatch(e.shiftKey ? -1 : 1);
                        }
                      }}
                      placeholder="查找"
                      className="h-6 w-24 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                    />
                    {findQuery && (
                      <button
                        type="button"
                        aria-label="清除查找"
                        onClick={() => {
                          setFindQuery('');
                          setCurrentMatch(0);
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {findQuery && matchIndices.length > 0 && (
                      <span className="whitespace-nowrap text-xs text-muted-foreground">
                        {currentMatch + 1}/{matchIndices.length}
                      </span>
                    )}
                    {findQuery && matchIndices.length === 0 && (
                      <span className="whitespace-nowrap text-xs text-red-500">0</span>
                    )}
                    <div className="flex items-center">
                      <button
                        type="button"
                        onClick={() => jumpMatch(-1)}
                        disabled={matchIndices.length === 0}
                        title="上一个（Shift+Enter）"
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => jumpMatch(1)}
                        disabled={matchIndices.length === 0}
                        title="下一个（Enter）"
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={handleCopyAll}>
                    <Copy className="mr-1 h-3.5 w-3.5" />
                    复制全部
                  </Button>
                </div>
              </div>
              <pre
                ref={rawPreRef}
                className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed"
              >
                {highlightSegments(rawText, findQuery)}
              </pre>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 按查询词切分文本并高亮（<mark>）；空查询原样返回。大小写不敏感。 */
function highlightSegments(text: string, query: string): ReactNode[] {
  if (!query) return [text];
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let key = 0;
  for (;;) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={key++} className="rounded-sm bg-yellow-300 px-0 text-black">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return parts;
}

/** 未知结构安全序列化（避免循环引用等导致 JSON.stringify 抛错） */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
