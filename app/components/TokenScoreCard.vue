<script setup lang="ts">
import { fmtPct, fmtUsd } from '~/shared/format'
import { isTradable } from '~/shared/solanaScoring'
import type { TokenScore } from '~/shared/types'

const props = defineProps<{ score: TokenScore; selected?: boolean }>()
defineEmits<{ select: [pairAddress: string] }>()

const t = computed(() => props.score.token)
const tradable = computed(() => isTradable(props.score))
const scoreColor = computed(() =>
  props.score.total >= 60 ? 'var(--up)' : props.score.total >= 40 ? 'var(--warn)' : 'var(--down)',
)
</script>

<template>
  <button class="token-card" :class="{ selected }" type="button" @click="$emit('select', t.pairAddress)">
    <div class="head">
      <span class="bold">{{ t.baseSymbol }}</span>
      <span class="xs dim name">{{ t.baseName }}</span>
      <span class="score mono bold" :style="{ color: scoreColor }">{{ score.total }}</span>
    </div>
    <div class="row mono xs">
      <span>{{ fmtUsd(t.priceUsd) }}</span>
      <span :class="t.change24hPct >= 0 ? 'up' : 'down'">{{ fmtPct(t.change24hPct) }}</span>
      <span class="dim">流動性 {{ fmtUsd(t.liquidityUsd) }}</span>
      <span class="dim">出来高 {{ fmtUsd(t.volume24hUsd) }}</span>
    </div>
    <div class="bars" aria-hidden="true">
      <div v-for="(v, k) in score.breakdown" :key="k" class="bar-wrap" :title="String(k)">
        <div class="bar" :style="{ width: `${v}%` }" />
      </div>
    </div>
    <div class="row xs">
      <span class="badge" :class="tradable ? 'badge-up' : 'badge-down'">
        {{ tradable ? '取引適格' : '基準未達' }}
      </span>
      <span class="dim">{{ t.ageHours < 24 ? `${t.ageHours.toFixed(0)}h` : `${(t.ageHours / 24).toFixed(0)}日` }}</span>
      <span v-if="score.warnings.length > 0" class="badge badge-warn">⚠ {{ score.warnings.length }}</span>
    </div>
    <div v-if="score.warnings.length > 0" class="xs down warnings">
      {{ score.warnings[0] }}<span v-if="score.warnings.length > 1"> 他{{ score.warnings.length - 1 }}件</span>
    </div>
  </button>
</template>

<style scoped>
.token-card {
  display: block;
  width: 100%;
  text-align: left;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  color: var(--text);
  cursor: pointer;
}
.token-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.head { display: flex; align-items: baseline; gap: 8px; }
.name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.score { font-size: 1.2rem; }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 4px; }
.bars { display: flex; gap: 4px; margin-top: 6px; }
.bar-wrap { flex: 1; height: 4px; background: var(--bg); border-radius: 2px; overflow: hidden; }
.bar { height: 100%; background: var(--accent); border-radius: 2px; }
.warnings { margin-top: 4px; }
</style>
