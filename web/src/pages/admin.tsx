/**
 * pages/admin.tsx — 系统管理页（仅管理员可见）
 *
 * 通用外壳：左侧 ADMIN_SECTIONS 注册表（证券行情设置 + 接口分类管理）。
 * 新增管理板块只需追加一条注册项，不改外壳（PRD P0-1/P0-2）。
 *
 * - 非管理员：整页「无权限访问该页面」，且左栏/板块均不渲染。
 * - 管理员：顶部板块切换 + 右栏渲染选中板块组件。
 */

import { useState } from 'react';
import { ServerCog, Tags } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useIsAdmin } from '@/stores/auth.store';
import { QuoteProviderSection } from '@/features/admin/quote-provider-section';
import { InterfaceCategorySection } from '@/features/admin/interface-category-section';

interface AdminSection {
  key: string;
  label: string;
  icon: JSX.Element;
  component: () => JSX.Element;
}

const ADMIN_SECTIONS: AdminSection[] = [
  {
    key: 'quote-provider',
    label: '证券行情设置',
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

export default function AdminPage(): JSX.Element {
  const isAdmin = useIsAdmin();
  const [active, setActive] = useState<string>(ADMIN_SECTIONS[0].key);

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">系统管理</h1>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            无权限访问该页面
          </CardContent>
        </Card>
      </div>
    );
  }

  const Active =
    ADMIN_SECTIONS.find((s) => s.key === active)?.component ??
    ADMIN_SECTIONS[0].component;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">系统管理</h1>
      <div className="flex gap-1 border-b">
        {ADMIN_SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setActive(s.key)}
            className={cn(
              'flex items-center border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              active === s.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {s.icon}
            {s.label}
          </button>
        ))}
      </div>
      <Active />
    </div>
  );
}
