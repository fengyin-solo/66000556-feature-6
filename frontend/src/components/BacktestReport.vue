<template>
  <div class="panel" v-if="store.gridResult">
    <h4>📋 回测报告</h4>
    <div class="metric-grid">
      <div class="metric">
        <div class="m-val" :class="store.gridResult.totalProfit>=0?'profit':'loss'">¥{{ store.gridResult.totalProfit.toFixed(0) }}</div>
        <div class="m-label">总盈亏</div>
      </div>
      <div class="metric"><div class="m-val" :class="store.gridResult.returnRate>=0?'profit':'loss'">{{ store.gridResult.returnRate.toFixed(2) }}%</div><div class="m-label">收益率</div></div>
      <div class="metric"><div class="m-val">{{ store.gridResult.sharpeRatio.toFixed(2) }}</div><div class="m-label">夏普比率</div></div>
      <div class="metric"><div class="m-val loss">{{ store.gridResult.maxDrawdown.toFixed(2) }}%</div><div class="m-label">最大回撤</div></div>
      <div class="metric"><div class="m-val">{{ store.gridResult.winRate.toFixed(1) }}%</div><div class="m-label">胜率</div></div>
      <div class="metric"><div class="m-val">{{ store.gridResult.orders.filter(o=>o.side==='SELL').length }}</div><div class="m-label">成交笔数</div></div>
    </div>
    <div ref="eqChart" class="chart"></div>

    <!-- 导出过滤条件 -->
    <div class="export-bar">
      <div class="section-title">导出成交记录</div>
      <div class="filter-row">
        <label class="f-item">
          <span class="f-label">成交方向</span>
          <el-select v-model="sideFilter" size="small" class="f-side" :disabled="exportState === 'exporting'">
            <el-option label="全部" value="ALL" />
            <el-option label="买入 BUY" value="BUY" />
            <el-option label="卖出 SELL" value="SELL" />
          </el-select>
        </label>
        <label class="f-item">
          <span class="f-label">笔数区间</span>
          <span class="range-box">
            <el-input v-model="range.min" size="small" placeholder="起始" class="f-num" :disabled="exportState === 'exporting'" @input="onFilterChange" />
            <span class="range-sep">-</span>
            <el-input v-model="range.max" size="small" placeholder="结束" class="f-num" :disabled="exportState === 'exporting'" @input="onFilterChange" />
          </span>
        </label>
      </div>
      <div class="filter-tip">
        <template v-if="validation.errors.length">
          <div v-for="(msg, i) in validation.errors" :key="i" class="tip-err">⚠️ {{ msg }}</div>
        </template>
        <template v-else-if="filteredOrders.length">
          <span class="tip-ok">命中 {{ filteredOrders.length }} 笔成交（序号 {{ validation.min }} - {{ validation.max }}）</span>
        </template>
      </div>
    </div>

    <!-- 与过滤结果逐条对应的成交列表 -->
    <div class="order-list" v-if="store.gridResult.orders.length">
      <el-table
        ref="tableRef"
        :data="filteredOrders"
        size="small"
        height="220"
        class="trade-table"
        empty-text="当前没有可导出的记录"
        @selection-change="onSelectionChange"
        @cell-click="onCellClick"
      >        <el-table-column type="selection" width="34" />
        <el-table-column label="#" width="34" prop="id" />
        <el-table-column label="方向" width="52">
          <template #default="{ row }">
            <span class="o-side" :class="row.side">{{ row.side === 'BUY' ? '买入' : '卖出' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="成交价" width="62">
          <template #default="{ row }">¥{{ row.price.toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="数量" width="60">
          <template #default="{ row }">{{ row.quantity.toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="单笔盈亏" min-width="66">
          <template #default="{ row }">
            <span :class="row.profit > 0 ? 'profit' : 'loss'">{{ row.profit > 0 ? '+' : '' }}{{ profitText(row) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 导出操作区 -->
    <div class="export-actions">
      <template v-if="exportState === 'ready'">
        <el-button type="success" size="small" @click="saveFile">💾 重新下载（仅可再下载 1 次）</el-button>
        <el-button size="small" @click="cancelExport">取消</el-button>
      </template>
      <template v-else-if="exportState === 'error'">
        <el-button type="warning" size="small" @click="retryExport">🔄 重试导出{{ selectedRows.length ? `（${selectedRows.length} 笔）` : '' }}</el-button>
        <el-button size="small" @click="cancelExport">取消</el-button>
      </template>
      <template v-else>
        <el-button
          type="primary"
          size="small"
          :loading="exportState === 'exporting'"
          :disabled="exportState === 'exporting' || validation.errors.length > 0"
          @click="startExport"
        >{{ exportState === 'exporting' ? '导出中…' : `导出选中记录（${selectedRows.length}）` }}</el-button>
      </template>

      <div class="export-msg tip-info" v-if="exportState === 'empty'">
        {{ filteredOrders.length === 0 ? '当前没有可导出的记录' : '请先勾选要导出的成交记录' }}
      </div>
      <div class="export-msg tip-err" v-else-if="exportState === 'error'">❌ {{ exportError }}</div>
      <div class="export-msg tip-ok" v-else-if="exportState === 'ready'">
        ✅ 已生成 {{ snapshot?.fileName }}。若浏览器保存框被取消，可点“重新下载”再保存一次
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import type { TableInstance } from 'element-plus'
import * as echarts from 'echarts'
import { useTradingStore } from '../store/trading'
import type { GridOrder } from '../types'
import {
  validateRange, filterOrders, createSnapshot, runExport,
  releaseExport, triggerDownload, isExporting, profitText,
  type SideFilter, type RangeState, type ExportSnapshot
} from '../utils/exportTrades'

const store = useTradingStore(); const eqChart = ref<HTMLDivElement>(); let inst: echarts.ECharts|null=null

function updateEq() {
  if (!inst||!store.gridResult) return
  const eq = store.gridResult.equityCurve
  inst.setOption({
    backgroundColor:'transparent',grid:{left:45,right:10,top:5,bottom:20},
    xAxis:{type:'category',data:eq.map((_,i)=>i),show:false},
    yAxis:{type:'value',axisLabel:{color:'#94a3b8',fontSize:9}},
    series:[{type:'line',data:eq,symbol:'none',lineStyle:{color:'#4fc3f7',width:1},
      areaStyle:{color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'rgba(79,195,247,0.2)'},{offset:1,color:'rgba(79,195,247,0)'}])}
    }],animation:false
  })
}
// 重新回测后刷新曲线；挂载时 gridResult 已存在，由 onMounted 完成首次渲染
watch(()=>store.gridResult,()=>{if(inst) setTimeout(updateEq,50)})
onMounted(()=>{ inst = echarts.init(eqChart.value!); updateEq() })
onUnmounted(()=>{inst?.dispose(); if (snapshot.value) releaseExport(snapshot.value)})

/* ---------- 过滤 ---------- */
const sideFilter = ref<SideFilter>('ALL')
const range = ref<RangeState>({ min: '1', max: '200' })
const validation = computed(() => validateRange(range.value))
const filteredOrders = computed(() =>
  store.gridResult ? filterOrders(store.gridResult.orders, sideFilter.value, validation.value) : []
)

/* ---------- 勾选 ---------- */
const tableRef = ref<TableInstance>()
// 勾选内容必须始终是“当前显示记录”的子集，保证导出与界面逐条对应
const selectedRows = ref<GridOrder[]>([])

function onSelectionChange(rows: GridOrder[]) {
  selectedRows.value = rows
}

function onCellClick(row: GridOrder, _col: unknown, cell: HTMLElement) {
  // 导出进行中/已就绪时锁定勾选，避免导出结果与界面不一致
  if (exportState.value === 'exporting' || exportState.value === 'ready') return
  // 点的是勾选框本身则不再手动 toggle，否则会切换两次
  if (cell.querySelector('.el-checkbox')) return
  tableRef.value?.toggleRowSelection(row)
}

/** 过滤条件输入（仅用于即时清掉“空记录”等瞬时提示，进行中不打断任务） */
function onFilterChange() {
  if (exportState.value === 'empty') exportState.value = 'idle'
}

// 方向/区间/新回测结果变化：取消未完成的任务并清空勾选，导出内容只对应当前显示
watch([sideFilter, validation, () => store.gridResult], async (n, old) => {
  const resultChanged = n[2] !== old?.[2]
  if (resultChanged || exportState.value !== 'exporting') abortExport()
  await nextTick()
  tableRef.value?.clearSelection()
  selectedRows.value = []
})

/* ---------- 导出状态机 ---------- */
type ExportPhase = 'idle' | 'exporting' | 'ready' | 'error' | 'empty'
const exportState = ref<ExportPhase>('idle')
const exportError = ref('')
const snapshot = ref<ExportSnapshot | null>(null)

/** 取消/重置：释放导出锁，使进行中的旧任务结果作废，不会再落地文件 */
function abortExport() {
  if (snapshot.value) releaseExport(snapshot.value)
  snapshot.value = null
  exportError.value = ''
  exportState.value = 'idle'
}

function cancelExport() {
  abortExport()
}

async function startExport() {
  // 连续点击闸门：进行中直接忽略，不产生第二份文件
  if (exportState.value === 'exporting' || isExporting()) return
  // 区间填反或为空等不合格项：不允许导出，逐项提示已在过滤区给出
  if (validation.value.errors.length) return
  // 没有命中记录：不生成文件
  if (filteredOrders.value.length === 0) {
    exportState.value = 'empty'
    return
  }
  // 未勾选任何记录：不生成文件
  if (selectedRows.value.length === 0) {
    exportState.value = 'empty'
    return
  }

  // 以“当前显示且勾选”的记录生成快照，行序与表格一致，导出即这些行
  const visible = new Set(filteredOrders.value)
  const rows = selectedRows.value.filter((r) => visible.has(r))
  if (rows.length === 0) {
    exportState.value = 'empty'
    return
  }
  snapshot.value = createSnapshot(rows)
  await doExport()
}

async function doExport() {
  if (!snapshot.value) return
  exportState.value = 'exporting'
  exportError.value = ''
  try {
    await runExport(snapshot.value)
    // 令牌已被取消释放（旧任务作废）：不落地文件
    if (!snapshot.value || !isExporting()) return
    // 导出成功：本次动作只落地一次下载，之后需要“重新下载”才能再触发
    triggerDownload(snapshot.value)
    releaseExport(snapshot.value)
    exportState.value = 'ready'
  } catch (e: any) {
    // 取消导致的过期失败：静默丢弃
    if (!snapshot.value || !isExporting()) return
    exportError.value = e?.message || '导出失败，请重试'
    exportState.value = 'error' // 失败保留快照与令牌，供“重试”复用
  }
}

/** 失败重试：复用同一份快照（同样的数据、同样的文件名），不产生重复文件 */
async function retryExport() {
  if (exportState.value !== 'error' || !snapshot.value) return
  await doExport()
}

/** 成功态下唯一一次重新下载（浏览器保存框点了“取消”后可再保存一次） */
function saveFile() {
  if (exportState.value !== 'ready' || !snapshot.value) return
  triggerDownload(snapshot.value)
  // 重新下载机会只给一次；之后需重新勾选/发起导出，杜绝连续点击生成多份
  snapshot.value = null
  exportState.value = 'idle'
}
</script>

<style scoped>
.panel{background:#0f1535;border-radius:8px;padding:12px;border:1px solid #1e2a5a}
.panel h4{color:#4fc3f7;font-size:13px;margin-bottom:8px}
.metric-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.metric{text-align:center;padding:8px;background:#0a0e27;border-radius:6px}
.m-val{font-size:18px;font-weight:700}.m-val.profit{color:#22c55e}.m-val.loss{color:#ef4444}
.m-label{font-size:10px;color:#64748b;margin-top:2px}
.chart{width:100%;height:120px;margin-top:8px}
.section-title{font-size:11px;color:#64748b;margin:6px 0 4px}

.export-bar{margin-top:6px;border-top:1px solid #1e2a5a;padding-top:6px}
.filter-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.f-item{display:flex;flex-direction:column;gap:2px}
.f-label{font-size:10px;color:#64748b}
.f-side{width:104px}
.range-box{display:flex;align-items:center;gap:4px}
.f-num{width:64px}
.range-sep{color:#64748b;font-size:11px}
.filter-tip{margin-top:4px;min-height:14px;font-size:10px;line-height:1.4}
.tip-err{color:#f59e0b}
.tip-ok{color:#22c55e}
.tip-info{color:#94a3b8}

.order-list{margin-top:6px}
.trade-table{background:transparent;font-size:11px;
  --el-table-bg-color:transparent;--el-table-tr-bg-color:transparent;
  --el-table-header-bg-color:#0a0e27;--el-table-border-color:#1e2a5a;
  --el-table-header-text-color:#94a3b8;--el-table-text-color:#cbd5e1;
  --el-table-row-hover-bg-color:#1e2a5a55;--el-table-empty-text-color:#64748b
}
.trade-table :deep(.el-table__cell){padding:2px 0}
.trade-table :deep(.el-table__inner-wrapper::before){background-color:#1e2a5a}
.trade-table :deep(th.el-table__cell){background:#0a0e27}
.trade-table :deep(.el-checkbox__inner){background-color:transparent;border-color:#64748b}
.o-side{font-weight:700;font-size:10px}
.o-side.BUY{color:#22c55e}.o-side.SELL{color:#ef4444}
.profit{color:#22c55e}.loss{color:#ef4444}

.export-actions{margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.export-msg{font-size:10px;line-height:1.4}
</style>
