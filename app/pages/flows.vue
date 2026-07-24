<script setup lang="ts">
import { ArrowDownLeft, ArrowUpRight } from '@lucide/vue'
import { ASSET_MAP } from '~/shared/assets'
import { netFlowByAsset } from '~/shared/flow'
import { fmtUsd } from '~/shared/format'
import type { FlowPeriod } from '~/shared/types'
import { useMarketStore } from '~/stores/market'

// 資金フローバブルマップ（UC-2 / F-02）
const market = useMarketStore()
const period = ref<FlowPeriod>('24h')
const selectedId = ref<string | null>(null)

const flows = computed(() => market.flowsFor(period.value))
const netFlows = computed(() => netFlowByAsset(flows.value))
const isMeasured = computed(() => market.flowSource(period.value) === 'measured-hybrid')

// 実測ネットフロー（Binance テイカーフロー）を期間切替時に取得
watch(period, (p) => void market.fetchNetFlows(p), { immediate: true })

const selectedAsset = computed(() => (selectedId.value ? ASSET_MAP[selectedId.value] : undefined))
const selectedNet = computed(() =>
  selectedId.value ? netFlows.value.get(selectedId.value) : undefined,
)
/** 選択銘柄に関係するフローの内訳（相手先別） */
const selectedFlowDetails = computed(() => {
  if (!selectedId.value) return []
  return flows.value
    .filter((f) => f.fromAssetId === selectedId.value || f.toAssetId === selectedId.value)
    .map((f) => ({
      direction: f.toAssetId === selectedId.value ? ('in' as const) : ('out' as const),
      counterpart:
        ASSET_MAP[f.toAssetId === selectedId.value ? f.fromAssetId : f.toAssetId]?.symbol ?? '?',
      amountUsd: f.amountUsd,
    }))
    .sort((a, b) => b.amountUsd - a.amountUsd)
    .slice(0, 8)
})

const PERIODS: { key: FlowPeriod; label: string }[] = [
  { key: '1h', label: '1時間' },
  { key: '24h', label: '24時間' },
  { key: '7d', label: '7日' },
]

useHead({ title: '資金フロー | Cryptia' })
</script>

<template>
  <div>
    <div class="card-title">
      <h1>資金フローマップ</h1>
      <span class="badge" :class="isMeasured ? 'badge-up' : 'badge-accent'">
        {{ isMeasured ? '実測ベース' : '推定値' }}
      </span>
    </div>
    <p class="small dim">
      バブルの大きさ = 時価総額、矢印の太さ = 資金フロー量。バブルはドラッグで動かせます。
      <template v-if="isMeasured">
        フロー量は Binance のテイカー買い/売り出来高から実測した銘柄別の資金流入出です（未上場銘柄は推定補完・銘柄間の経路配分は比例配分）。
      </template>
      <template v-else>
        出来高と騰落率から推定した参考値です（実測データ取得中または未取得）。
      </template>
    </p>

    <div class="tabs" role="tablist" style="margin-bottom: 12px; max-width: 320px">
      <button
        v-for="p in PERIODS"
        :key="p.key"
        class="tab"
        :class="{ active: period === p.key }"
        role="tab"
        :aria-selected="period === p.key"
        type="button"
        @click="period = p.key"
      >
        {{ p.label }}
      </button>
    </div>

    <BubbleMap
      :tickers="market.tickers"
      :flows="flows"
      :selected-id="selectedId"
      @select="(id) => (selectedId = id)"
    />

    <!-- 選択バブルの内訳（UC-2: タップで流入・流出の内訳） -->
    <section v-if="selectedAsset" class="card" style="margin-top: 12px">
      <div class="card-title">
        <h2>
          <span :style="{ color: selectedAsset.color }">{{ selectedAsset.symbol }}</span>
          {{ selectedAsset.nameJa }} の資金フロー内訳
        </h2>
        <button class="btn btn-sm btn-ghost" type="button" @click="selectedId = null">閉じる</button>
      </div>
      <div class="net-row">
        <span class="badge badge-up">流入 {{ fmtUsd(selectedNet?.inUsd ?? 0) }}</span>
        <span class="badge badge-down">流出 {{ fmtUsd(selectedNet?.outUsd ?? 0) }}</span>
        <span class="badge" :class="(selectedNet?.inUsd ?? 0) >= (selectedNet?.outUsd ?? 0) ? 'badge-up' : 'badge-down'">
          純流入 {{ fmtUsd((selectedNet?.inUsd ?? 0) - (selectedNet?.outUsd ?? 0)) }}
        </span>
      </div>
      <ul class="flow-list">
        <li v-for="(d, i) in selectedFlowDetails" :key="i">
          <span :class="d.direction === 'in' ? 'up' : 'down'" style="display: inline-flex; align-items: center; gap: 3px">
            <ArrowDownLeft v-if="d.direction === 'in'" :size="14" aria-hidden="true" />
            <ArrowUpRight v-else :size="14" aria-hidden="true" />
            {{ d.direction === 'in' ? '流入' : '流出' }}
          </span>
          <span class="bold">{{ d.counterpart }}</span>
          <span class="mono dim">{{ fmtUsd(d.amountUsd) }}</span>
        </li>
        <li v-if="selectedFlowDetails.length === 0" class="dim small">
          この期間で有意なフローは検出されていません
        </li>
      </ul>
    </section>
    <p v-else class="xs faint center" style="margin-top: 10px">バブルをタップすると銘柄別の流入・流出内訳が表示されます</p>
  </div>
</template>

<style scoped>
.net-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.flow-list { list-style: none; margin: 0; padding: 0; }
.flow-list li {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
  font-size: 0.85rem;
}
.flow-list li:last-child { border-bottom: none; }
.flow-list li span:last-child { margin-left: auto; }
</style>
