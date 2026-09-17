import type { AttributeDef } from './queries'

/**
 * 用户属性取值的显示文案。
 *
 * 存进去的永远是规范值（bool 存 'true'/'false'，date 存 ISO），而操作者看的是
 * 中文界面，所以展示层做一次翻译；筛选、排序、比较仍然用存储值。
 */
export function attributeValueLabel(
  def: AttributeDef | undefined,
  value: string
): string {
  if (value === undefined || value === null || value === '') return '—'
  switch (def?.type) {
    case 'bool':
      return value === 'true' ? '是' : value === 'false' ? '否' : value
    case 'date': {
      const ms = Date.parse(value)
      return Number.isFinite(ms) ? new Date(ms).toLocaleDateString() : value
    }
    default:
      return value
  }
}
