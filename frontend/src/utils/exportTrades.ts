import type { GridOrder } from '@/types'

/**
 * 成交记录导出工具
 *
 * 设计要点：
 * - 校验/过滤/CSV 生成均为纯函数，结果与报告当前展示的记录保持逐条一致
 * - 模拟一次真实的文件导出（耗时 + 可能失败），失败后可对同一批数据重试
 * - 导出成功后浏览器只会为一次有效导出动作触发一次保存；重复点击不会产生多份文件
 */

export type SideFilter = 'ALL' | 'BUY' | 'SELL'

export interface RangeState {
  min: string
  max: string
}

export interface RangeValidation {
  valid: boolean
  /** 不合格项，按填写顺序给出，用于在界面上逐项指出 */
  errors: string[]
  min: number | null
  max: number | null
}

/**
 * 校验“成交笔数区间”：
 * - 为空（任一端未填）不允许导出
 * - 必须是 >=1 的整数
 * - 区间填反（下界 > 上界）不允许导出
 */
export function validateRange(range: RangeState): RangeValidation {
  const errors: string[] = []
  const minRaw = range.min.trim()
  const maxRaw = range.max.trim()

  if (minRaw === '') errors.push('成交笔数区间的“起始笔数”为空，请填写后再导出')
  if (maxRaw === '') errors.push('成交笔数区间的“结束笔数”为空，请填写后再导出')

  let min: number | null = null
  let max: number | null = null

  if (minRaw !== '') {
    min = Number(minRaw)
    if (!Number.isFinite(min) || !Number.isInteger(min) || min < 1) {
      errors.push('“起始笔数”必须是不小于 1 的整数')
      min = null
    }
  }
  if (maxRaw !== '') {
    max = Number(maxRaw)
    if (!Number.isFinite(max) || !Number.isInteger(max) || max < 1) {
      errors.push('“结束笔数”必须是不小于 1 的整数')
      max = null
    }
  }

  if (min !== null && max !== null && min > max) {
    errors.push(`成交笔数区间填反了：起始笔数 ${min} 大于结束笔数 ${max}`)
  }

  return { valid: errors.length === 0, errors, min, max }
}

/**
 * 按成交方向 + 成交笔数区间过滤。
 * 笔数以成交记录在整笔成交中的序号（记录 id）为准。
 */
export function filterOrders(
  orders: GridOrder[],
  side: SideFilter,
  validation: RangeValidation
): GridOrder[] {
  if (!validation.valid || validation.min === null || validation.max === null) return []
  return orders.filter(
    (o) =>
      (side === 'ALL' || o.side === side) &&
      o.id >= validation.min! &&
      o.id <= validation.max!
  )
}

/** CSV 单元格转义：含逗号、引号或换行时用双引号包裹，内部引号双写 */
function escapeCell(value: string | number): string {
  const s = String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 单笔盈亏展示口径：买入成交不产生已实现盈亏，显示 0.00（与报告列表一致） */
export function profitText(o: GridOrder): string {
  return o.side === 'SELL' ? o.profit.toFixed(2) : (0).toFixed(2)
}

/** 导出列头；每行与界面表格展示的记录、数值格式保持一致 */
const CSV_HEADER = ['序号', '成交方向', '成交价格', '成交数量', '单笔盈亏']

/** 生成 CSV 文本，行序与勾选/展示顺序一致 */
export function buildCsv(rows: GridOrder[]): string {
  const lines = [CSV_HEADER.join(',')]
  for (const o of rows) {
    lines.push(
      [
        o.id,
        o.side,
        o.price.toFixed(2),
        o.quantity.toFixed(2),
        profitText(o)
      ]
        .map(escapeCell)
        .join(',')
    )
  }
  return lines.join('\r\n')
}

export interface ExportSnapshot {
  rows: GridOrder[]
  csv: string
  fileName: string
  blob: Blob
  /** 每次“新的导出动作”生成一个令牌；重试沿用同一令牌，成功后该令牌只允许重新下载一次 */
  token: number
  createdAt: number
}

let tokenSeq = 0
let activeToken: number | null = null

/** 是否已有导出任务在进行中（连续点击的第一道闸门） */
export function isExporting(): boolean {
  return activeToken !== null
}

export function createSnapshot(rows: GridOrder[]): ExportSnapshot {
  const csv = buildCsv(rows)
  // 加 UTF-8 BOM，保证 Excel 直接打开时中文不乱码
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const stamp = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const fileName = `成交记录_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(
    stamp.getDate()
  )}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.csv`
  return { rows, csv, fileName, blob, token: ++tokenSeq, createdAt: Date.now() }
}

/**
 * 模拟把文件提交到“导出通道”（实际项目中这里是上传/生成接口）。
 * 随机失败，便于演示失败重试；重试复用同一份快照，不会生成第二份文件。
 */
export function runExport(snapshot: ExportSnapshot): Promise<void> {
  if (activeToken !== null && activeToken !== snapshot.token) {
    return Promise.reject(new Error('已有导出任务进行中，请勿重复点击'))
  }
  activeToken = snapshot.token
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      // 只有当前任务可以落地结果；已取消（令牌被释放）的过期任务直接作废
      if (activeToken !== snapshot.token) {
        reject(new Error('导出请求已过期'))
        return
      }
      if (Math.random() < 0.35) {
        reject(new Error('导出失败：文件服务暂时不可用，请重试'))
        return
      }
      resolve()
    }, 600)
  })
}

/** 任务终态/取消后释放导出锁（取消后后台旧任务的结果将作废，不会回写界面） */
export function releaseExport(snapshot: ExportSnapshot | null): void {
  if (snapshot && activeToken === snapshot.token) activeToken = null
}

/** 已创建的对象 URL，成功完成后释放，避免内存泄漏与重复占用 */
let currentUrl: string | null = null

/**
 * 触发浏览器下载。
 * 同一快照在“成功”态下只允许调用一次（点击保存或取消后），
 * 由调用方配合重下载开关保证连续点击不会产生多份重复文件。
 */
export function triggerDownload(snapshot: ExportSnapshot): void {
  if (currentUrl) URL.revokeObjectURL(currentUrl)
  currentUrl = URL.createObjectURL(snapshot.blob)
  const a = document.createElement('a')
  a.href = currentUrl
  a.download = snapshot.fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 稍后回收，保证浏览器已拿到文件流
  setTimeout(() => {
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl)
      currentUrl = null
    }
  }, 30_000)
}

/** 测试辅助：重置模块内部锁与令牌 */
export function _resetExportState(): void {
  activeToken = null
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl)
    currentUrl = null
  }
}
