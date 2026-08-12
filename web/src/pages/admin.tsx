/**
 * pages/admin.tsx — 金融数据接口页（仅管理员可见）
 *
 * 导航结构（系统管理 → 金融数据接口，单层折叠）：
 *   系统管理（左侧栏可折叠父级，app 侧边栏入口）
 *     └─ 金融数据接口（本页；点击进入，左侧栏选中态）
 *
 * - 仅管理员可见：非管理员整页「无权限访问该页面」，且左栏/板块均不渲染。
 * - 左侧栏：系统管理为可展开/收起的父级，其下唯一子项「金融数据接口」即本页入口
 *   （带 Chevron 指示展开态）。「接口API来源」「接口分类管理」不在左栏出现。
 * - 页面内：以标签页（分页）形式呈现「接口API来源」与「接口分类管理」两个模块，
 *   点击标签切换即在右栏渲染对应内容（MODULES 注册表，新增板块只需追加一条）。
 */

import { useState } from 'react';
import { Database, ServerCog, Tags, ChevronRight, ChevronDown } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useIsAdmin } from '@/stores/auth.store';
import { QuoteProviderSection } from '@/features/admin/quote-provider-section';
import { InterfaceCategorySection } from '@/features/admin/interface-category-section';

interface AdminModule {
  key: string;
  label: string;
  icon: JSX.Element;
  component: () => JSX.Element;
}

/** 金融数据接口页面内的两个分页模块（标签）。 */
const MODULES: AdminModule[] = [
  {
    key: 'quote-provider',
    label: '接口API来源',
    icon: <ServerCog className="mr-2 h-4 w-4" />,
    component: QuoteProviderSection,
  },
  {
    key: 'interface-category',
    label: '接口分类管理',
    icon: <Tags className="mr-2 h-4 w-4" />,
    component: InterfaceCategorySection,
  },
];

/** 按 key 检索模块；未命中回退到第一个模块。 */
function findModule(key: string): AdminModule {
  return MODULES.find((m) => m.key === key) ?? MODULES[0];
}

export default function AdminPage(): JSX.Element {
  const isAdmin = useIsAdmin();
  const [active, setActive] = useState<string>(MODULES[0].key);
  const [sysOpen, setSysOpen] = useState<boolean>(true);

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">金融数据接口</h1>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            无权限访问该页面
          </CardContent>
        </Card>
      </div>
    );
  }

  const Active = findModule(active).component;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">金融数据接口</h1>
      <div className="flex gap-6">
        <nav className="w-56 shrink-0 border-r pr-3">
          <div className="mb-4">
            <button
              type="button"
              onClick={() => setSysOpen((v) => !v)}
              aria-expanded={sysOpen}
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
            >
              <span>系统管理</span>
              {sysOpen ? (
                <ChevronDown className="h-4 w-4 shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0" />
              )}
            </button>
            {sysOpen && (
              <div className="ml-2 border-l pl-2">
                <button
                  type="button"
                  onClick={() => setActive(MODULES[0].key)}
                  className="mb-1 flex w-full items-center rounded-md bg-primary/10 px-2 py-1.5 text-sm font-medium text-primary"
                >
                  <Database className="mr-2 h-4 w-4" />
                  金融数据接口
                </button>
              </div>
            )}
          </div>
        </nav>
        <div className="min-w-0 flex-1">
          <div className="mb-4 flex flex-wrap gap-2">
            {MODULES.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setActive(m.key)}
                className={cn(
                  'flex items-center rounded-md border px-3 py-1.5 text-sm transition-colors',
                  active === m.key
                    ? 'border-primary bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {m.icon}
                {m.label}
              </button>
            ))}
          </div>
          <Active />
        </div>
      </div>
    </div>
  );
}
