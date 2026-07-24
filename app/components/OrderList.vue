<script setup lang="ts">
import { ASSET_MAP } from '~/shared/assets'
import { fmtQty, fmtTime, fmtUsd } from '~/shared/format'
import type { Order } from '~/shared/types'

// 注文履歴。PC はテーブル、モバイルはカード表示に切替える（原則8）
const props = withDefaults(
  defineProps<{
    orders: Order[]
    limit?: number
    /** 銘柄マスタ外の assetId（Solana ペアアドレス等）をシンボルへ解決する（ISSUE-6） */
    symbolResolver?: (assetId: string) => string | undefined
  }>(),
  { limit: 50, symbolResolver: undefined },
)

const shown = computed(() => [...props.orders].reverse().slice(0, props.limit))
function symbolOf(assetId: string) {
  const resolved = props.symbolResolver?.(assetId) ?? ASSET_MAP[assetId]?.symbol
  if (resolved) return resolved
  // 未解決の長い ID（ペアアドレス等）はレイアウトを壊さないよう短縮表示
  return assetId.length > 12 ? `${assetId.slice(0, 8)}…` : assetId
}
</script>

<template>
  <div>
    <p v-if="shown.length === 0" class="dim small center" style="padding: 16px 0">
      まだ注文はありません
    </p>

    <!-- PC: テーブル -->
    <div v-else class="table-view">
      <table class="data">
        <thead>
          <tr>
            <th>日時</th>
            <th>銘柄</th>
            <th>売買</th>
            <th>数量</th>
            <th>単価</th>
            <th>金額</th>
            <th>実現損益</th>
            <th>判断理由</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in shown" :key="o.id">
            <td class="mono xs nowrap">{{ fmtTime(o.executedAt) }}</td>
            <td class="bold">{{ symbolOf(o.assetId) }}</td>
            <td>
              <span class="badge" :class="o.side === 'buy' ? 'badge-up' : 'badge-down'">
                {{ o.side === 'buy' ? '買' : '売' }}
              </span>
            </td>
            <td class="mono">{{ fmtQty(o.quantity) }}</td>
            <td class="mono">{{ fmtUsd(o.priceUsd) }}</td>
            <td class="mono">{{ fmtUsd(o.notionalUsd) }}</td>
            <td class="mono" :class="o.realizedPnlUsd > 0 ? 'up' : o.realizedPnlUsd < 0 ? 'down' : 'dim'">
              {{ o.side === 'sell' ? fmtUsd(o.realizedPnlUsd) : '—' }}
            </td>
            <td class="small dim reason-cell">{{ o.reason }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- モバイル: カード -->
    <div v-if="shown.length > 0" class="cards-view">
      <div v-for="o in shown" :key="o.id" class="order-card">
        <div class="row1">
          <span class="badge" :class="o.side === 'buy' ? 'badge-up' : 'badge-down'">
            {{ o.side === 'buy' ? '買' : '売' }}
          </span>
          <span class="bold">{{ symbolOf(o.assetId) }}</span>
          <span class="mono small">{{ fmtUsd(o.notionalUsd) }}</span>
          <span class="mono xs faint">{{ fmtTime(o.executedAt) }}</span>
        </div>
        <div class="row2 mono xs dim">
          {{ fmtQty(o.quantity) }} @ {{ fmtUsd(o.priceUsd) }}
          <span
            v-if="o.side === 'sell'"
            :class="o.realizedPnlUsd > 0 ? 'up' : o.realizedPnlUsd < 0 ? 'down' : ''"
          >
            損益 {{ fmtUsd(o.realizedPnlUsd) }}
          </span>
        </div>
        <div class="xs dim">{{ o.reason }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.table-view { display: none; overflow-x: auto; }
.reason-cell { max-width: 320px; }
.cards-view { display: flex; flex-direction: column; gap: 8px; }
.order-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.row1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.row1 span:last-child { margin-left: auto; }
.row2 { display: flex; gap: 10px; margin: 3px 0; }
@media (min-width: 768px) {
  .table-view { display: block; }
  .cards-view { display: none; }
}
</style>
