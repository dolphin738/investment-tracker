/**
 * pages/admin.tsx — 系统管理页（仅管理员可见）
 *
 * 当前提供「证券行情 API 地址」配置项：读取 / 保存 securities_quote_api_base_url。
 * 非管理员访问时仅展示「无权限访问」，且不发起任何 /admin 请求（useSystemConfig enabled:false）。
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useIsAdmin } from '@/stores/auth.store';
import { useSystemConfig, useUpdateSystemConfig } from '@/hooks/use-system-config';

/** 证券行情 API 地址对应的系统配置键 */
const QUOTE_API_KEY = 'securities_quote_api_base_url';

export default function AdminPage(): JSX.Element {
  const isAdmin = useIsAdmin();
  const { data, isLoading } = useSystemConfig(QUOTE_API_KEY);
  const updateMutation = useUpdateSystemConfig(QUOTE_API_KEY);
  const [url, setUrl] = useState('');

  // 配置加载完成后同步到本地输入态（仅当 value.url 为字符串时）
  useEffect(() => {
    if (data?.value && typeof data.value.url === 'string') {
      setUrl(data.value.url);
    }
  }, [data]);

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

  const handleSave = (): void => {
    updateMutation.mutate({ url });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">系统管理</h1>
        <p className="text-sm text-muted-foreground">配置全局系统参数（仅管理员可见）</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">证券行情 API 地址</CardTitle>
          <CardDescription>
            设置证券行情数据接口的基础地址，供全站行情拉取使用
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载中…
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="quote-api-url">API 基础地址</Label>
              <Input
                id="quote-api-url"
                placeholder="https://example.com/api"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                留空表示未配置；保存后立即对所有用户生效
              </p>
            </div>
          )}

          <Button onClick={handleSave} disabled={isLoading || updateMutation.isPending}>
            {updateMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            保存
          </Button>

          {updateMutation.isError && (
            <p className="text-xs text-red-500">保存失败，请重试</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
