/**
 * components/ui/dropdown-menu.tsx — 自定义 Dropdown Menu
 *
 * 由于环境限制无法安装 @radix-ui/react-dropdown-menu，
 * 基于 @radix-ui/react-popover 实现 dropdown 风格的菜单组件，
 * 暴露 shadcn/ui 兼容的 API：DropdownMenu / Trigger / Content / Item / Label / Separator。
 */

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';

const DropdownMenu = PopoverPrimitive.Root;
const DropdownMenuTrigger = PopoverPrimitive.Trigger;
const DropdownMenuPortal = PopoverPrimitive.Portal;

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    sideOffset?: number;
  }
>(({ className, sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2',
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';

interface DropdownMenuItemProps
  extends React.HTMLAttributes<HTMLDivElement> {
  inset?: boolean;
  /** 选择后是否自动关闭菜单（默认 true） */
  closeOnSelect?: boolean;
}

const DropdownMenuItem = React.forwardRef<
  HTMLDivElement,
  DropdownMenuItemProps
>(({ className, inset, closeOnSelect = true, onClick, ...props }, ref) => {
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    onClick?.(e);
    if (closeOnSelect) {
      // 关闭 Popover：通过 dispatch Escape key
      setTimeout(() => {
        const escEvent = new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
        });
        document.dispatchEvent(escEvent);
      }, 0);
    }
  };
  return (
    <div
      ref={ref}
      role="menuitem"
      className={cn(
        'relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        inset && 'pl-8',
        className,
      )}
      onClick={handleClick}
      {...props}
    />
  );
});
DropdownMenuItem.displayName = 'DropdownMenuItem';

const DropdownMenuLabel = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'px-2 py-1.5 text-sm font-semibold',
      inset && 'pl-8',
      className,
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = 'DropdownMenuLabel';

const DropdownMenuSeparator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-muted', className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuPortal,
};
