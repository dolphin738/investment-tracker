/**
 * features/account/edit-profile-dialog.tsx — 编辑个人资料对话框
 *
 * 受控组件：通过 open / onOpenChange 控制显隐。
 *
 * 头像（AC-11）：支持两种设置方式，二者均在编辑资料卡片内完成：
 *   1）本地上传 —— 点击头像唤起文件选择 → 前端预校验（类型 + 大小）→ 上传 → 后端落盘写库后回写预览；
 *   2）头像 URL —— 在下方输入框填入图片地址，随「保存」一起提交生效。
 * 两种方式并列，最后生效者覆盖前者；「移除头像」可清空为默认头像。
 *
 * 清空语义：未填字段统一归一为空串 '' 再提交，后端把 '' 转成 NULL，
 * 这样「把昵称删掉后保存」才能真正清空，而不是被当作「不修改」。
 */

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Camera, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { UserAvatar } from '@/components/user-avatar';
import { useUpdateProfile, useUploadAvatar } from '@/hooks/use-account';
import { useAuthStore } from '@/stores/auth.store';

/** 允许上传的图片 MIME（与后端 upload.constants.ts 的 ALLOWED_MIME 保持一致） */
const ACCEPTED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** 单文件大小上限 2MB（与后端 MAX_SIZE 保持一致） */
const MAX_AVATAR_SIZE = 2 * 1024 * 1024;

/** <input accept> 属性值 */
const ACCEPT_ATTR = ACCEPTED_IMAGE_MIME.join(',');

/** 与后端 update-profile.dto.ts 保持一致的校验规则（空串代表清空，需放行） */
const editProfileSchema = z.object({
  // 头像由上传流程写入，可能是站内相对路径（/api/uploads/...）或历史 http(s) 外链，
  // 与后端放宽后的 AVATAR_PATTERN 对齐，不再强制要求协议头。
  avatar: z
    .string()
    .max(512, '头像地址最多 512 字符')
    // /^\/(?!\/)/ 与后端一致地排除 `//evil.com` 这类协议相对 URL
    .refine((v) => v === '' || /^\/(?!\/)/.test(v) || /^https?:\/\//.test(v), {
      message: '头像地址格式不正确',
    }),
  name: z.string().max(100, '昵称最多 100 字'),
  phone: z
    .string()
    .refine((v) => v === '' || /^1[3-9]\d{9}$/.test(v), {
      message: '请输入正确的手机号',
    }),
  bio: z.string().max(200, '简介最多 200 字'),
});

type EditProfileFormValues = z.infer<typeof editProfileSchema>;

export interface EditProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditProfileDialog({
  open,
  onOpenChange,
}: EditProfileDialogProps): JSX.Element {
  const user = useAuthStore((s) => s.user);
  const updateMutation = useUpdateProfile();
  const uploadMutation = useUploadAvatar();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<EditProfileFormValues>({
    resolver: zodResolver(editProfileSchema),
    defaultValues: { avatar: '', name: '', phone: '', bio: '' },
  });

  // 表单只在「对话框打开」这一刻用当前用户信息初始化一次。
  //
  // 依赖数组刻意不含 user：上传头像成功后 useUploadAvatar 会 setUser(data.user)，
  // 换掉 auth store 里 user 的引用；若把 user 放进依赖，effect 会重跑 reset()，
  // 把 isDirty 冲回 false，「保存」按钮（disabled={isBusy || !isDirty}）随即变灰点不动。
  // 用 getState() 而不是闭包里的 user，既能拿到最新值，又不触发 exhaustive-deps 告警。
  useEffect(() => {
    if (open) {
      const currentUser = useAuthStore.getState().user;
      reset({
        avatar: currentUser?.avatar ?? '',
        name: currentUser?.name ?? '',
        phone: currentUser?.phone ?? '',
        bio: currentUser?.bio ?? '',
      });
    }
  }, [open, reset]);

  const avatarValue = watch('avatar') ?? '';
  const nameValue = watch('name') ?? '';
  const bioValue = watch('bio') ?? '';

  const isUploading = uploadMutation.isPending;
  const isPending = updateMutation.isPending;
  const isBusy = isUploading || isPending;

  /**
   * 头像 URL 输入框的草稿值（§7.9 · SET-P0-01 验收 2）
   *
   * 与表单里的 avatar 分离：输入过程中只改草稿，点「应用」才写进表单并刷新预览。
   * 这样「输入到一半」不会把半截 URL 塞进待提交数据，也让 [应用] 有明确语义。
   */
  const [avatarUrlDraft, setAvatarUrlDraft] = useState<string>('');

  // 表单里的 avatar 变化时回灌草稿：覆盖「打开对话框初始化」「本地上传成功」
  // 「移除头像」三条路径，保证输入框与实际头像始终一致。
  useEffect(() => {
    setAvatarUrlDraft(avatarValue);
  }, [avatarValue]);

  /** 点击 [应用]：把草稿 URL 写进表单，立即刷新上方头像预览，随「保存」提交生效 */
  const handleApplyAvatarUrl = (): void => {
    if (isBusy) {
      return;
    }
    setValue('avatar', avatarUrlDraft.trim(), {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  /** 打开系统文件选择器 */
  const handlePickFile = (): void => {
    if (isBusy) {
      return;
    }
    fileInputRef.current?.click();
  };

  /**
   * 文件选择回调：前端预校验不通过时只提示、不发请求，
   * 避免把明显非法的文件推到后端换一个更慢的 400。
   */
  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // 立即清空 input.value，保证同一个文件连续选两次也能再次触发 onChange
    event.target.value = '';
    if (!file) {
      return;
    }

    if (!ACCEPTED_IMAGE_MIME.includes(file.type as (typeof ACCEPTED_IMAGE_MIME)[number])) {
      toast.error('仅支持 JPG / PNG / WebP 格式的图片');
      return;
    }
    if (file.size > MAX_AVATAR_SIZE) {
      toast.error('图片大小不能超过 2MB');
      return;
    }

    uploadMutation.mutate(file, {
      onSuccess: (data) => {
        // 写回表单：既用于本地预览，也让「保存」时把新地址一并提交
        setValue('avatar', data.url, { shouldDirty: true });
      },
    });
  };

  /**
   * 移除头像：直接 PATCH avatar='' 让后端置 NULL。
   * 磁盘上的旧文件不在此处删除（下次上传新头像时由后端顺带清理），
   * 避免用户「移除后又后悔」时文件已经没了。
   */
  const handleRemoveAvatar = (): void => {
    if (isBusy || !avatarValue) {
      return;
    }
    updateMutation.mutate(
      { avatar: '' },
      {
        onSuccess: () => {
          setValue('avatar', '', { shouldDirty: false });
        },
      },
    );
  };

  const onSubmit = (values: EditProfileFormValues): void => {
    // 未填字段归一为 ''，明确表达「清空」语义
    updateMutation.mutate(
      {
        name: values.name ?? '',
        avatar: values.avatar ?? '',
        phone: values.phone ?? '',
        bio: values.bio ?? '',
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑资料</DialogTitle>
          <DialogDescription>
            点击头像可更换图片，其余字段留空表示清除该项
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)}>
          <div className="space-y-4">
            {/* 头像上传区 */}
            <div className="flex items-center gap-4">
              <div className="group relative h-16 w-16 shrink-0">
                <button
                  type="button"
                  onClick={handlePickFile}
                  disabled={isBusy}
                  aria-label="更换头像"
                  className="relative block h-16 w-16 overflow-hidden rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed"
                >
                  <UserAvatar
                    size="lg"
                    src={avatarValue || null}
                    name={nameValue || user?.name}
                    email={user?.email ?? ''}
                  />
                  {/* hover 蒙层 / 上传中遮罩 */}
                  <span
                    className={
                      isUploading
                        ? 'absolute inset-0 flex items-center justify-center rounded-full bg-black/50 text-white opacity-100'
                        : 'absolute inset-0 flex flex-col items-center justify-center gap-0.5 rounded-full bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100'
                    }
                  >
                    {isUploading ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <>
                        <Camera className="h-4 w-4" />
                        <span className="text-[10px] leading-none">更换头像</span>
                      </>
                    )}
                  </span>
                </button>

                {/* 移除头像：仅在已有头像且非忙碌时出现 */}
                {avatarValue && !isUploading && (
                  <button
                    type="button"
                    onClick={handleRemoveAvatar}
                    disabled={isBusy}
                    aria-label="移除头像"
                    title="移除头像"
                    className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-background bg-destructive text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>

              <div className="flex-1 space-y-1">
                <Label>头像</Label>
                <p className="text-xs text-muted-foreground">
                  支持 JPG / PNG / WebP，大小不超过 2MB
                </p>
                {errors.avatar && (
                  <p className="text-xs text-red-500">{errors.avatar.message}</p>
                )}
              </div>

              {/* 隐藏的文件输入框 */}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept={ACCEPT_ATTR}
                onChange={handleFileChange}
              />
              {/* avatar 只读，值由上传流程写入，注册进表单以便随「保存」一起提交 */}
              <input type="hidden" {...register('avatar')} />
            </div>

            {/* 头像 URL：与本地上传并列，最后生效者覆盖前者，随「保存」一起提交 */}
            <div className="space-y-1.5">
              <Label htmlFor="profile-avatar-url">头像 URL</Label>
              <div className="flex gap-2">
                <Input
                  id="profile-avatar-url"
                  type="text"
                  inputMode="url"
                  placeholder="https://example.com/avatar.png"
                  value={avatarUrlDraft}
                  onChange={(e) => setAvatarUrlDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // 回车等价于点「应用」，避免在 <form> 内误触发提交
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleApplyAvatarUrl();
                    }
                  }}
                  disabled={isBusy}
                />
                {/*
                  显式 [应用] 按钮（§7.9 L1417-1419 · SET-P0-01 验收 2）：
                  草图要求「输入图片 URL 后点『应用』即可设为头像」，
                  点击后立刻写入表单并刷新上方头像预览，随「保存」提交生效。
                  type="button" 必须显式声明，否则会被当作 form 的默认 submit。
                */}
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleApplyAvatarUrl}
                  disabled={isBusy || avatarUrlDraft === avatarValue}
                >
                  应用
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                输入图片 URL 后点「应用」即可预览并设为头像；与本地上传并列，
                二者最后生效者覆盖前者，最终随「保存」提交
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="profile-name">昵称</Label>
              <Input
                id="profile-name"
                placeholder="如：张三"
                {...register('name')}
              />
              {errors.name && (
                <p className="text-xs text-red-500">{errors.name.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-phone">手机号</Label>
              <Input
                id="profile-phone"
                inputMode="numeric"
                placeholder="13800138000"
                {...register('phone')}
              />
              {errors.phone && (
                <p className="text-xs text-red-500">{errors.phone.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="profile-bio">个人简介</Label>
                <span className="text-xs text-muted-foreground">
                  {bioValue.length}/200
                </span>
              </div>
              <Textarea
                id="profile-bio"
                rows={3}
                placeholder="一句话介绍自己的投资风格"
                {...register('bio')}
              />
              {errors.bio && (
                <p className="text-xs text-red-500">{errors.bio.message}</p>
              )}
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isBusy}
            >
              取消
            </Button>
            <Button type="submit" disabled={isBusy || !isDirty}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
