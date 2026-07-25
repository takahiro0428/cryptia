<script setup lang="ts">
import { TriangleAlert } from '@lucide/vue'
import { fmtAgo, fmtPct, fmtQty, fmtTokenAge, fmtUsd } from '~/shared/format'
import { SNIPE_VERDICT_LABELS } from '~/shared/snipeScoring'
import { positionOf } from '~/shared/tradeEngine'
import { useSolanaStore } from '~/stores/solana'

/**
 * 保有ポジションのその場詳細パネル（F-05/F-06）。
 * ポジション行のタップで展開され、ページ遷移せずにトークンの詳細
 * （価格・エントリー価格・損益・流動性・ラダー進捗・監査判定・CA）を確認できる。
 */
const props = defineProps<{ pairAddress: string }>()

const solana = useSolanaStore()

const token = computed(() => solana.tokenOf(props.pairAddress))
const position = computed(() =>
  solana.portfolio ? positionOf(solana.portfolio, props.pairAddress) : undefined,
)
const meta = computed(() => solana.positionMeta[props.pairAddress])

const priceUsd = computed(() => token.value?.priceUsd ?? position.value?.avgCostUsd ?? 0)
const valueUsd = computed(() => (position.value?.quantity ?? 0) * priceUsd.value)
const pnlUsd = computed(() =>
  position.value ? (priceUsd.value - position.value.avgCostUsd) * position.value.quantity : 0,
)
const pnlPct = computed(() =>
  position.value && position.value.avgCostUsd > 0
    ? ((priceUsd.value - position.value.avgCostUsd) / position.value.avgCostUsd) * 100
    : 0,
)

/** 新規上場リストに載っていれば監査判定も表示する */
const freshScore = computed(() =>
  solana.freshTokens.find((s) => s.token.pairAddress === props.pairAddress),
)
const VERDICT = SNIPE_VERDICT_LABELS

/**
 * AI 手法は買い増しで平均取得単価が動くため、損益の基準である平均取得単価を表示する。
 * ラダー系（1 トークン 1 回の等分エントリー）は初回エントリー価格 = 平均取得単価。
 */
const isAiMethod = computed(() => solana.method === 'ai')

/** 未発動のラダーライン（エントリー価格基準の目標価格つき） */
const ladderLines = computed(() => {
  if (!meta.value || isAiMethod.value) return []
  return solana.ladderRules
    .map((rule, index) => ({
      rule,
      index,
      targetUsd: meta.value!.entryPriceUsd * (1 + rule.triggerPct / 100),
      fired: meta.value!.triggered.includes(index),
    }))
    .filter((l) => !l.fired)
})
</script>

<template>
  <div class="detail">
    <div class="stats">
      <div>
        <div class="xs faint">現在価格</div>
        <div class="mono small">{{ fmtUsd(priceUsd) }}</div>
      </div>
      <div v-if="meta && !isAiMethod">
        <div class="xs faint">エントリー価格</div>
        <div class="mono small">{{ fmtUsd(meta.entryPriceUsd) }}</div>
      </div>
      <div v-else-if="position">
        <!-- AI 手法は買い増しで平均が動くため、損益の基準と同じ平均取得単価を表示 -->
        <div class="xs faint">平均取得単価</div>
        <div class="mono small">{{ fmtUsd(position.avgCostUsd) }}</div>
      </div>
      <div>
        <div class="xs faint">損益</div>
        <div class="mono small" :class="pnlUsd >= 0 ? 'up' : 'down'">
          {{ fmtUsd(pnlUsd) }}（{{ fmtPct(pnlPct) }}）
        </div>
      </div>
      <div>
        <div class="xs faint">数量 / 評価額</div>
        <div class="mono small">{{ fmtQty(position?.quantity ?? 0) }} / {{ fmtUsd(valueUsd) }}</div>
      </div>
    </div>

    <div v-if="token" class="row xs dim">
      <span :class="token.change24hPct >= 0 ? 'up' : 'down'">24h {{ fmtPct(token.change24hPct) }}</span>
      <span>流動性 {{ fmtUsd(token.liquidityUsd) }}</span>
      <span>出来高24h {{ fmtUsd(token.volume24hUsd) }}</span>
      <span>発行 {{ fmtTokenAge(token.ageHours) }}前</span>
      <span>取引 {{ token.txns24h }}件/24h</span>
    </div>
    <p v-else class="xs" style="color: var(--warn); margin: 0">
      <TriangleAlert :size="11" class="icon-inline" aria-hidden="true" />
      現在この銘柄の市場情報を取得できていません（表示は最終取得値・取得単価ベース）
    </p>

    <!-- ラダーの残りライン（次の利確・損切り価格を可視化） -->
    <div v-if="ladderLines.length > 0" class="row xs">
      <span class="faint">残りライン:</span>
      <span
        v-for="l in ladderLines"
        :key="l.index"
        class="line mono"
        :class="l.rule.triggerPct >= 0 ? 'up' : 'down'"
      >
        {{ l.rule.triggerPct >= 0 ? '+' : '' }}{{ l.rule.triggerPct }}% ({{ fmtUsd(l.targetUsd) }})
        残数量の{{ Math.round(l.rule.sellRatio * 100) }}%を決済
      </span>
    </div>

    <div v-if="freshScore" class="row xs">
      <span class="faint">監査判定:</span>
      <span class="badge" :class="VERDICT[freshScore.verdict].cls">{{ VERDICT[freshScore.verdict].label }}</span>
      <span class="mono dim">スコア {{ freshScore.total }}</span>
      <!-- 時点はプール全体の更新時刻ではなく、この銘柄を発見フィードで最後に確認した時刻 -->
      <span v-if="solana.freshSeenAt[pairAddress] ?? solana.freshFetchedAt" class="faint">
        （{{ fmtAgo(solana.freshSeenAt[pairAddress] ?? solana.freshFetchedAt) }}時点）
      </span>
    </div>

    <!-- CA の確認・コピー（トークンカードと同じ共通部品） -->
    <TokenAddressRow v-if="token" :address="token.baseAddress" />
    <TokenAddressRow v-else label="ペア" :address="pairAddress" />
  </div>
</template>

<style scoped>
.detail {
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin: 6px 0 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
@media (min-width: 768px) { .stats { grid-template-columns: repeat(4, 1fr); } }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.line {
  padding: 2px 7px;
  border-radius: 99px;
  border: 1px solid var(--border);
  font-size: 0.68rem;
}
</style>
