import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { QueryGate } from '@/components/query-gate'
import { userAttributesQueryOptions, type AttributeDef } from './queries'

const TYPES: { value: AttributeDef['type']; label: string }[] = [
  { value: 'text', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'select', label: '单选' },
  { value: 'date', label: '日期' },
  { value: 'bool', label: '布尔' },
]

type DefForm = {
  key: string
  name: string
  type: AttributeDef['type']
  /** Comma separated in the UI, an array on the wire. */
  options: string
  default_value: string
  show_in_filter: boolean
  sort_order: string
}

const EMPTY_DEF: DefForm = {
  key: '',
  name: '',
  type: 'text',
  options: '',
  default_value: '',
  show_in_filter: true,
  sort_order: '0',
}

function parseOptions(raw: string): string[] {
  return raw
    .split(/[,，\n]/)
    .map((v) => v.trim())
    .filter(Boolean)
}

/**
 * 属性定义 — the schema behind 用户属性. Without this screen the feature is a
 * table nobody can fill, so it is a sibling dialog of the users list rather than
 * a separate route: an operator defines a field and immediately uses it as a
 * filter on the list behind.
 */
export function AttributeDefsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const query = useQuery(userAttributesQueryOptions())
  const defs = query.data?.attributes || []
  const [form, setForm] = useState<DefForm>(EMPTY_DEF)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [deleting, setDeleting] = useState<AttributeDef | null>(null)

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ['panel', 'user-attributes'] })

  const reset = () => {
    setForm(EMPTY_DEF)
    setEditingId(null)
  }

  const openEdit = (def: AttributeDef) => {
    setEditingId(def.id)
    setForm({
      key: def.key,
      name: def.name,
      type: def.type,
      options: def.options.join(', '),
      default_value: def.default_value || '',
      show_in_filter: def.show_in_filter,
      sort_order: String(def.sort_order ?? 0),
    })
  }

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        key: form.key,
        name: form.name,
        type: form.type,
        options: parseOptions(form.options),
        default_value: form.default_value || null,
        show_in_filter: form.show_in_filter,
        sort_order: Number(form.sort_order) || 0,
      }
      if (editingId != null) {
        return api(`/api/panel/user-attributes/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        })
      }
      return api('/api/panel/user-attributes', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },
    onSuccess: async () => {
      toast.success(editingId != null ? '已保存属性定义' : '已新增属性定义')
      reset()
      await refresh()
    },
    // The server rejects a select without options and a duplicate key; showing
    // its message verbatim is the only way the operator learns which one it was.
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: (id: number) =>
      api(`/api/panel/user-attributes/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('已删除，该属性的用户取值同时清除')
      setDeleting(null)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const needsOptions =
    form.type === 'select' && !parseOptions(form.options).length

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className='max-w-3xl'>
        <DialogHeader>
          <DialogTitle>用户属性定义</DialogTitle>
          <DialogDescription>
            定义一次即可在用户列表按该属性筛选；键名会转成小写下划线形式，取值类型决定能否比较大小。
          </DialogDescription>
        </DialogHeader>

        <div className='grid gap-3 rounded-md border p-3'>
          <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
            <div className='grid gap-1.5'>
              <Label htmlFor='def-name'>名称</Label>
              <Input
                id='def-name'
                value={form.name}
                placeholder='渠道来源'
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='def-key'>键名</Label>
              <Input
                id='def-key'
                value={form.key}
                placeholder='留空则取名称'
                onChange={(e) => setForm({ ...form, key: e.target.value })}
              />
            </div>
            <div className='grid gap-1.5'>
              <Label>类型</Label>
              <Select
                value={form.type}
                onValueChange={(type) =>
                  setForm({ ...form, type: type as AttributeDef['type'] })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {form.type === 'select' ? (
              <div className='grid gap-1.5 sm:col-span-2'>
                <Label htmlFor='def-options'>可选项（逗号分隔）</Label>
                <Input
                  id='def-options'
                  value={form.options}
                  placeholder='抖音, B站, 朋友推荐'
                  onChange={(e) =>
                    setForm({ ...form, options: e.target.value })
                  }
                />
              </div>
            ) : null}
            <div className='grid gap-1.5'>
              <Label htmlFor='def-default'>默认值</Label>
              <Input
                id='def-default'
                value={form.default_value}
                onChange={(e) =>
                  setForm({ ...form, default_value: e.target.value })
                }
              />
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='def-sort'>排序</Label>
              <Input
                id='def-sort'
                value={form.sort_order}
                onChange={(e) =>
                  setForm({ ...form, sort_order: e.target.value })
                }
              />
            </div>
            <div className='grid gap-1.5'>
              <Label>列表筛选</Label>
              <Select
                value={form.show_in_filter ? 'yes' : 'no'}
                onValueChange={(v) =>
                  setForm({ ...form, show_in_filter: v === 'yes' })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='yes'>在用户列表显示筛选</SelectItem>
                  <SelectItem value='no'>仅编辑用户时可见</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className='flex justify-end gap-2'>
            {editingId != null ? (
              <Button variant='outline' onClick={reset}>
                取消编辑
              </Button>
            ) : null}
            <Button
              loading={save.isPending}
              disabled={(!form.key && !form.name) || needsOptions}
              onClick={() => save.mutate()}
            >
              {editingId != null ? '保存定义' : '新增定义'}
            </Button>
          </div>
        </div>

        <QueryGate
          loading={query.isLoading}
          error={query.error}
          skeleton={<div className='h-24 animate-pulse rounded-md border' />}
        >
          <div className='overflow-hidden rounded-md border'>
            <Table density='compact'>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>键名</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>取值</TableHead>
                  <TableHead>筛选</TableHead>
                  <TableHead className='text-right'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {defs.length ? (
                  defs.map((def) => (
                    <TableRow key={def.id}>
                      <TableCell>{def.name}</TableCell>
                      <TableCell className='font-mono text-xs'>
                        {def.key}
                      </TableCell>
                      <TableCell>
                        {TYPES.find((t) => t.value === def.type)?.label ||
                          def.type}
                      </TableCell>
                      <TableCell className='max-w-[16rem] truncate text-xs text-muted-foreground'>
                        {def.type === 'select'
                          ? (def.used_values.length
                              ? def.used_values
                              : def.options
                            ).join(' / ') || '—'
                          : def.default_value || '—'}
                      </TableCell>
                      <TableCell>
                        {def.show_in_filter ? (
                          <Badge variant='secondary'>显示</Badge>
                        ) : (
                          <span className='text-muted-foreground'>隐藏</span>
                        )}
                      </TableCell>
                      <TableCell className='text-right'>
                        <div className='flex justify-end gap-1'>
                          <Button
                            size='sm'
                            variant='ghost'
                            onClick={() => openEdit(def)}
                          >
                            编辑
                          </Button>
                          <Button
                            size='sm'
                            variant='ghost'
                            className='text-destructive'
                            onClick={() => setDeleting(def)}
                          >
                            删除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className='h-20 text-center text-muted-foreground'
                    >
                      还没有自定义属性
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </QueryGate>

        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={() => setDeleting(null)}
        title='删除属性定义'
        desc={`删除「${deleting?.name || ''}」？所有用户在该属性上的取值会一并清除。`}
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        isLoading={remove.isPending}
        handleConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Dialog>
  )
}
