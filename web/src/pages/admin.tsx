/**
 * pages/admin.tsx — 金融数据接口页（仅管理员可见）
 *
 * 导航结构：折叠交互位于最左侧主侧边栏（components/layout/sidebar）——
 *   「系统管理」为可折叠父级，其下唯一子项「金融数据接口」链到本页。
 *   本页自身不再划分左侧栏，避免在页面内单独实现折叠。
 *
 * - 仅管理员可见：非管理员整页「无权限访问该页面」。
 * - 页面内：以标签页（分页）形式呈现「接口API来源」与「接口分类管理」两个模块，
 *   点击标签切换即在下方渲染对应内容（MODULES 注册表，新增板块只需追加一条）。
 */

import { useState } from 'react';
import { ServerCog, Tags, ListChecks } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useIsAdmin } from '@/stores/auth.store';
import { QuoteProviderSection } from '@/features/admin/quote-provider-section';
import { InterfaceCategorySection } from '@/features/admin/interface-category-section';
import { StockListTestSection } from '@/features/admin/stock-list-test-section';

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
  {
    key: 'stock-list-test',
    label: '股票列表和测试',
    icon: <ListChecks className="mr-2 h-4 w-4" />,
    component: StockListTestSection,
  },
];

/** 按 key 检索模块；未命中回退到第一个模块。 */
function findModule(key: string): AdminModule {
  return MODULES.find((m) => m.key === key) ?? MODULES[0];
}

export default function AdminPage(): JSX.Element {
  const isAdmin = useIsAdmin();
  const [active, setActive] = useState<string>(MODULES[0].key);

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
  );
}
