/**
 * features/admin/interface-category-dialog.tsx — 接口分类新增/编辑对话框
 *
 * 字段：label、icon（lucide 图标名）、sort_order。
 * label 重复时后端允许（UI 自行去重展示），此处不二次提示。
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { InterfaceCategory } from '@/api/interface-category.api';
import {
  useCreateInterfaceCategory,
  useUpdateInterfaceCategory,
} from '@/hooks/use-interface-category';

interface FormState {
  label: string;
  icon: string;
  sortOrder: string;
}

function toForm(edit: InterfaceCategory | null): FormState {
  if (!edit) {
    return { label: '', icon: '', sortOrder: '0' };
  }
  return {
    label: edit.label,
    icon: edit.icon ?? '',
    sortOrder: String(edit.sort_order),
  };
}

export interface InterfaceCategoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: InterfaceCategory | null;
}

export function InterfaceCategoryDialog({
  open,
  onOpenChange,
  editing,
}: InterfaceCategoryDialogProps): JSX.Element {
  const createMut = useCreateInterfaceCategory();
  const updateMut = useUpdateInterfaceCategory();
  const [form, setForm] = useState<FormState>(() => toForm(editing));

  useEffect(() => {
    if (open) setForm(toForm(editing));
  }, [open, editing]);

  const pending = createMut.isPending || updateMut.isPending;

  const handleSubmit = (): void => {
    if (!form.label.trim()) {
      return;
    }
    const payload = {
      label: form.label.trim(),
      icon: form.icon.trim() || null,
      sort_order: form.sortOrder.trim() ? Number(form.sortOrder) : 0,
    };
    if (editing) {
      updateMut.mutate(
        { id: editing.id, body: payload },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      createMut.mutate(payload, { onSuccess: () => onOpenChange(false) });
    }
  };

  const close = (): void => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑分类' : '新增分类'}</DialogTitle>
          <DialogDescription>
            {editing ? '修改接口分类' : '新增一个接口分类（用于接口下拉与汇总）'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cat-label">展示名</Label>
            <Input
              id="cat-label"
              placeholder="如 A股列表"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="cat-icon">图标（lucide 名）</Label>
              <Input
                id="cat-icon"
                placeholder="如 List"
                value={form.icon}
                onChange={(e) => setForm({ ...form, icon: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cat-order">排序</Label>
              <Input
                id="cat-order"
                type="number"
                value={form.sortOrder}
                onChange={(e) =>
                  setForm({ ...form, sortOrder: e.target.value })
                }
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
