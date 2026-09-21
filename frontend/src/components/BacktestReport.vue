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

    <div class="section-title">成交记录导出</div>
    <div class="export-bar">
      <div class="filter-row">
        <label class="filter-item">
          <span class="f-label">成交方向</span>
          <select v-model="sideFilter" class="f-input">
            <option value="ALL">全部</option>
            <option value="BUY">买入</option>
            <option value="SELL">卖出</option>
          </select>
        </label>
      </div>
      <div class="filter-row">
        <label class="filter-item">
          <span class="f-label">笔数起</span>
          <input v-model="rangeMinText" type="number" min="1" step="1" placeholder="如 1"
            class="f-input" :class="{bad: badFields.has('min') || badFields.has('format')}" />
        </label>
        <span class="f-sep">至</span>
        <label class="filter-item">
          <span class="f-label">笔数止</span>
          <input v-model="rangeMaxText" type="number" min="1" step="1" placeholder="如 20"
            class="f-input" :class="{bad: badFields.has('max') || badFields.has('format')}" />
        </label>
      </div>
      <div class="filter-tip invalid" v-if="rangeError">{{ rangeError }}</div>

      <div class="record-box" v-if="!rangeError">
        <div class="record-empty" v-if="!filteredOrders.length">当前没有可导出的记录</div>
        <template v-else>
          <div class="record-head">
            <label class="ck">
              <input type="checkbox" :checked="allChecked" :indeterminate.prop="someChecked && !allChecked" @change="toggleAll" />
            </label>
            <span class="c-no">序号</span>
            <span class="c-side">方向</span>
            <span class="c-price">成交价</span>
            <span class="c-qty">数量</span>
            <span class="c-profit">单笔盈亏</span>
          </div>
          <div class="record-body">
            <label v-for="o in filteredOrders" :key="o.id" class="record-row" :class="o.side">
              <input class="ck" type="checkbox" :value="o.id" v-model="selectedIds" />
              <span class="c-no">{{ o.id }}</span>
              <span class="c-side" :class="o.side">{{ o.side==='BUY'?'买入':'卖出' }}</span>
              <span class="c-price">¥{{ o.price }}</span>
              <span class="c-qty">{{ o.quantity.toFixed(2) }}</span>
              <span class="c-profit" :class="o.profit>0?'profit':(o.profit<0?'loss':'')">{{ o.profit>0?'+':'' }}{{ o.profit.toFixed(2) }}</span>
            </label>
          </div>
          <div class="select-line">
            已选 <b>{{ selectedIds.length }}</b> / {{ filteredOrders.length }} 条
            <span class="select-warn" v-if="!selectedIds.length">（请先勾选要导出的成交记录）</span>
          </div>
        </template>
      </div>

      <div class="export-actions">
        <button class="btn-export" :disabled="!canExport || exporting" @click="doExport(false)">
          {{ exporting ? '导出中…' : '导出所选记录' }}
        </button>
        <button class="btn-retry" v-if="exportState==='failed'" @click="doExport(false)">重试导出</button>
        <button class="btn-retry" v-if="exportState==='success'" @click="doExport(true)">重新下载</button>
      </div>
      <div class="filter-tip" v-if="exportMessage" :class="exportState">{{ exportMessage }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import * as echarts from 'echarts'
import { useTradingStore } from '../store/trading'
import type { GridOrder } from '../types'
const store = useTradingStore(); const eqChart = ref<HTMLDivElement>(); let inst: echarts.ECharts|null=null

// ---------- 成交记录过滤 ----------
const sideFilter = ref<'ALL'|'BUY'|'SELL'>('ALL')
const rangeMinText = ref('')
const rangeMaxText = ref('')
const selectedIds = ref<number[]>([])

function parseBound(text: string): number {
  const t = text.trim()
  if (t === '') return NaN
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
}
const rangeMin = computed(() => parseBound(rangeMinText.value))
const rangeMax = computed(() => parseBound(rangeMaxText.value))

type BadField = 'min'|'max'|'format'
const badFields = computed<Set<BadField>>(() => {
  const bad = new Set<BadField>()
  if (Number.isNaN(rangeMin.value)) bad.add('min')
  if (Number.isNaN(rangeMax.value)) bad.add('max')
  const bothFilled = !bad.has('min') && !bad.has('max')
  if (bothFilled && (rangeMin.value < 1 || rangeMax.value < 1 ||
      !Number.isInteger(rangeMin.value) || !Number.isInteger(rangeMax.value))) bad.add('format')
  if (bothFilled && !bad.has('format') && rangeMin.value > rangeMax.value) { bad.add('min'); bad.add('max') }
  return bad
})

const rangeError = computed(() => {
  const bad = badFields.value
  if (!bad.size) return ''
  if (bad.has('format')) return '无法导出：笔数区间需为不小于 1 的正整数，请修改后再导出'
  const names: string[] = []
  if (bad.has('min')) names.push('「笔数起」')
  if (bad.has('max')) names.push('「笔数止」')
  if (bad.has('min') && bad.has('max') && rangeMinText.value.trim() !== '' && rangeMaxText.value.trim() !== '')
    return `无法导出：笔数区间填反了（起 ${rangeMin.value} ＞ 止 ${rangeMax.value}），请修改后再导出`
  return `无法导出：${names.join('、')}未填写，笔数区间不能为空，请补全后再导出`
})

// 与报告当前显示的记录逐条对应：先按方向过滤，再按成交笔数（成交序号）区间过滤
const filteredOrders = computed<GridOrder[]>(() => {
  if (!store.gridResult || rangeError.value) return []
  return store.gridResult.orders.filter(o =>
    (sideFilter.value === 'ALL' || o.side === sideFilter.value) && o.id >= rangeMin.value && o.id <= rangeMax.value)
})

const allChecked = computed(() => filteredOrders.value.length > 0 && selectedIds.value.length === filteredOrders.value.length)
const someChecked = computed(() => selectedIds.value.length > 0)

function toggleAll(e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  selectedIds.value = checked ? filteredOrders.value.map(o => o.id) : []
}

// 过滤条件变化时剔除已失效的勾选并重置导出状态
watch([sideFilter, rangeMinText, rangeMaxText], () => {
  const valid = new Set(filteredOrders.value.map(o => o.id))
  selectedIds.value = selectedIds.value.filter(id => valid.has(id))
  resetExportState()
})

// ---------- 导出文件 ----------
type ExportState = 'idle'|'exporting'|'success'|'failed'
const exportState = ref<ExportState>('idle')
const exportMessage = ref('')
const exporting = ref(false)
let lastUrl: string | null = null
let lastFilename: string | null = null
let lastCount = 0

const canExport = computed(() => !rangeError.value && filteredOrders.value.length > 0 && selectedIds.value.length > 0)

function resetExportState() {
  exportState.value = 'idle'
  exportMessage.value = ''
}

function buildCsv(orders: GridOrder[]): string {
  const header = ['成交序号', '成交方向', '成交价格', '成交数量', '单笔盈亏']
  const rows = orders.map(o => [
    String(o.id),
    o.side === 'BUY' ? '买入' : '卖出',
    o.price.toFixed(2),
    o.quantity.toFixed(2),
    o.profit.toFixed(2),
  ])
  return '﻿' + [header, ...rows].map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n')
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

// isRedownload: 成功后用户取消了保存框时，可再下载一次（复用同一份结果，不重复生成文件）
async function doExport(isRedownload: boolean) {
  if (exporting.value) return // 连续点击保护：导出进行中直接忽略，不会产生多份重复文件
  if (!isRedownload) {
    if (rangeError.value) { exportState.value = 'failed'; exportMessage.value = rangeError.value; return }
    if (!filteredOrders.value.length) { exportState.value = 'failed'; exportMessage.value = '当前没有可导出的记录'; return }
    if (!selectedIds.value.length) { exportState.value = 'failed'; exportMessage.value = '请先勾选要导出的成交记录'; return }
  } else if (!lastUrl) {
    exportState.value = 'failed'; exportMessage.value = '上次导出结果已失效，请重新导出'
    return
  }

  exporting.value = true
  exportState.value = 'exporting'
  exportMessage.value = '正在生成导出文件…'
  try {
    let url: string
    let filename: string
    if (isRedownload && lastUrl) {
      url = lastUrl // 复用已生成文件，取消后重新下载不会多出文件
      filename = lastFilename!
    } else {
      // 导出瞬间快照勾选记录，保证文件内容与当前显示、所勾选逐条对应
      const idSet = new Set(selectedIds.value)
      const snapshot = filteredOrders.value.filter(o => idSet.has(o.id))
      const blob = new Blob([buildCsv(snapshot)], { type: 'text/csv;charset=utf-8' })
      if (lastUrl) URL.revokeObjectURL(lastUrl)
      url = URL.createObjectURL(blob)
      const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
      filename = `回测成交记录_${snapshot.length}条_${ts}.csv`
      lastUrl = url
      lastFilename = filename
      lastCount = snapshot.length
    }
    triggerDownload(url, filename)
    exportState.value = 'success'
    const count = isRedownload ? `${lastCount} 条` : `${selectedIds.value.length} 条`
    exportMessage.value = `已导出 ${count}记录（${filename}）。若保存框被取消，可点「重新下载」再试一次`
  } catch (err) {
    exportState.value = 'failed'
    exportMessage.value = `导出失败：${err instanceof Error ? err.message : String(err)}，可点「重试导出」`
  } finally {
    exporting.value = false
  }
}

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
watch(() => store.gridResult, (r) => {
  if (r) {
    // 新报告：重置过滤、勾选与上次导出结果
    selectedIds.value = []
    sideFilter.value = 'ALL'
    rangeMinText.value = ''
    rangeMaxText.value = ''
    resetExportState()
    if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; lastFilename = null }
    if (!inst && eqChart.value) inst = echarts.init(eqChart.value)
    setTimeout(updateEq, 50)
  }
})
onUnmounted(() => { inst?.dispose(); if (lastUrl) URL.revokeObjectURL(lastUrl) })
</script>

<style scoped>
.panel{background:#0f1535;border-radius:8px;padding:12px;border:1px solid #1e2a5a}
.panel h4{color:#4fc3f7;font-size:13px;margin-bottom:8px}
.metric-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.metric{text-align:center;padding:8px;background:#0a0e27;border-radius:6px}
.m-val{font-size:18px;font-weight:700}.m-val.profit{color:#22c55e}.m-val.loss{color:#ef4444}
.m-label{font-size:10px;color:#64748b;margin-top:2px}
.chart{width:100%;height:120px;margin-top:8px}
.section-title{font-size:11px;color:#64748b;margin:8px 0 4px}

.export-bar{background:#0a0e27;border-radius:6px;padding:8px}
.filter-row{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.filter-item{display:flex;align-items:center;gap:4px;flex:1}
.f-label{font-size:10px;color:#94a3b8;white-space:nowrap}
.f-input{flex:1;min-width:0;background:#0f1535;border:1px solid #1e2a5a;border-radius:4px;color:#e0e0e0;
  font-size:11px;padding:4px 6px;outline:none}
.f-input:focus{border-color:#4fc3f7}
.f-input.bad{border-color:#ef4444;background:#ef444410}
select.f-input{cursor:pointer}
.f-sep{font-size:10px;color:#64748b}
.filter-tip{font-size:10px;line-height:1.5;margin-top:2px;color:#94a3b8}
.filter-tip.invalid,.filter-tip.failed{color:#ef4444}
.filter-tip.success{color:#22c55e}

.record-box{margin-top:6px;border:1px solid #1e2a5a;border-radius:4px;overflow:hidden}
.record-empty{padding:14px 8px;text-align:center;font-size:11px;color:#f59e0b}
.record-head,.record-row{display:grid;grid-template-columns:24px 32px 38px 1fr 1fr 56px;align-items:center;gap:2px;font-size:10px}
.record-head{padding:4px 6px;background:#11193a;color:#64748b;position:sticky;top:0}
.record-body{max-height:170px;overflow-y:auto}
.record-row{padding:3px 6px;cursor:pointer;color:#cbd5e1}
.record-row.BUY{background:#22c55e0d}.record-row.SELL{background:#ef44440d}
.record-row:hover{background:#4fc3f715}
.ck{margin:0;cursor:pointer;accent-color:#4fc3f7}
.c-no{color:#64748b}
.c-side.BUY{color:#22c55e}.c-side.SELL{color:#ef4444}
.c-price{color:#94a3b8}
.c-qty{color:#94a3b8}
.c-profit{text-align:right}
.c-profit.profit{color:#22c55e}.c-profit.loss{color:#ef4444}
.select-line{padding:4px 8px;font-size:10px;color:#94a3b8;border-top:1px solid #1e2a5a;background:#0f1535}
.select-line b{color:#4fc3f7}
.select-warn{color:#f59e0b}

.export-actions{display:flex;gap:6px;margin-top:8px}
.btn-export{flex:1;background:#0ea5e9;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:600;
  padding:7px 10px;cursor:pointer}
.btn-export:hover:not(:disabled){background:#0284c7}
.btn-export:disabled{background:#1e2a5a;color:#64748b;cursor:not-allowed}
.btn-retry{background:none;border:1px solid #f59e0b;color:#f59e0b;border-radius:4px;font-size:12px;padding:7px 12px;cursor:pointer}
.btn-retry:hover{background:#f59e0b15}
</style>
