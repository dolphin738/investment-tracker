/**
 * components/user-avatar.tsx — 用户头像
 *
 * 有 src 且图片加载成功时渲染 <img>；否则渲染圆形色块 + 名称/邮箱首字母。
 * 仓库未引入 shadcn Avatar（@radix-ui/react-avatar），此处用原生元素自建，零新增依赖。
 */

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export interface UserAvatarProps {
  /** 头像 URL，可为空 */
  src?: string | null;
  /** 显示名称，用于生成占位首字母 */
  name?: string | null;
  /** 邮箱，name 为空时用于生成占位首字母 */
  email: string;
  /** 尺寸：sm = 列表/导航；lg = 设置页大头像 */
  size?: 'sm' | 'lg';
  /** 额外样式 */
  className?: string;
}

/** 取占位首字母：优先 name，其次 email，统一大写 */
function resolveInitial(name?: string | null, email?: string): string {
  const fromName = name?.trim()?.[0];
  if (fromName) {
    return fromName.toUpperCase();
  }
  const fromEmail = email?.trim()?.[0];
  return fromEmail ? fromEmail.toUpperCase() : '?';
}

export function UserAvatar({
  src,
  name,
  email,
  size = 'sm',
  className,
}: UserAvatarProps): JSX.Element {
  // 图片加载失败时回退到首字母占位
  const [failed, setFailed] = useState(false);

  // src 变化时重置失败状态，允许新地址重新尝试加载
  useEffect(() => {
    setFailed(false);
  }, [src]);

  const sizeClass = size === 'lg' ? 'h-16 w-16 text-xl' : 'h-9 w-9 text-sm';
  const showImage = Boolean(src) && !failed;

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 font-medium text-primary',
        sizeClass,
        className,
      )}
      title={name || email}
    >
      {showImage ? (
        <img
          src={src as string}
          alt={name || email}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>{resolveInitial(name, email)}</span>
      )}
    </div>
  );
}
