<script setup lang="ts">
import { AtSign, Ban, CircleCheck, Globe, MessageCircle, TriangleAlert } from '@lucide/vue'
import { fmtPct, fmtUsd } from '~/shared/format'
import type { SnipeScore } from '~/shared/snipeScoring'

// 新規上場ハンター（スナイプ）のトークンカード（F-06）
const props = defineProps<{ score: SnipeScore; selected?: boolean }>()
defineEmits<{ select: [pairAddress: string] }>()

const t = computed(() => props.score.token)
const s = computed(() => props.score.signals)

const VERDICT = {
  candidate: { label: '候補', cls: 'badge-up' },
  caution: { label: '要注意', cls: 'badge-warn' },
  avoid: { label: '回避', cls: 'badge-down' },
} as const

const scoreColor = computed(() =>
  props.score.total >= 60 ? 'var(--up)' : props.score.total >= 40 ? 'var(--warn)' : 'var(--down)',
)

function fmtAge(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}分`
  if (hours < 24) return `${hours.toFixed(0)}時間`
  return `${(hours / 24).toFixed(1)}日`
}
</script>

<template>
  <button
    class="token-card"
    :class="{ selected, avoid: score.verdict === 'avoid' }"
    type="button"
    :aria-pressed="!!selected"
    @click="$emit('select', t.pairAddress)"
  >
    <div class="head">
      <span class="bold">{{ t.baseSymbol }}</span>
      <span class="xs dim name">{{ t.baseName }}</span>
      <span class="badge" :class="VERDICT[score.verdict].cls">{{ VERDICT[score.verdict].label }}</span>
      <span class="score mono bold" :style="{ color: scoreColor }">{{ score.total }}</span>
    </div>
    <div class="row mono xs">
      <span>{{ fmtUsd(t.priceUsd) }}</span>
      <span :class="t.change24hPct >= 0 ? 'up' : 'down'">{{ fmtPct(t.change24hPct) }}</span>
      <span class="dim">流動性 {{ fmtUsd(t.liquidityUsd) }}</span>
      <span class="dim">発行 {{ fmtAge(t.ageHours) }}前</span>
    </div>

    <!-- 選定シグナル（SNS / dev 情報 / 再発行） -->
    <div class="row xs signals">
      <span class="sig" :class="s.hasWebsite ? 'on' : 'off'">
        <Globe :size="12" aria-hidden="true" /> サイト
      </span>
      <span class="sig" :class="s.hasTwitter ? 'on' : 'off'">
        <AtSign :size="12" aria-hidden="true" /> X
      </span>
      <span class="sig" :class="s.hasTelegram ? 'on' : 'off'">
        <MessageCircle :size="12" aria-hidden="true" /> TG
      </span>
      <span class="sig" :class="s.mintAuthorityRenounced === true ? 'on' : s.mintAuthorityRenounced === false ? 'bad' : 'off'">
        <component :is="s.mintAuthorityRenounced === false ? TriangleAlert : CircleCheck" :size="12" aria-hidden="true" />
        mint{{ s.mintAuthorityRenounced === true ? '放棄' : s.mintAuthorityRenounced === false ? '残存' : '不明' }}
      </span>
      <span class="sig" :class="s.duplicateCount === 0 ? 'on' : (s.duplicateCount ?? 0) > 0 ? 'bad' : 'off'">
        <component :is="(s.duplicateCount ?? 0) > 0 ? Ban : CircleCheck" :size="12" aria-hidden="true" />
        再発行{{ s.duplicateCount === null ? '未照合' : s.duplicateCount === 0 ? 'なし' : `${s.duplicateCount}件` }}
      </span>
    </div>

    <div v-if="score.warnings.length > 0" class="xs down warnings">
      <TriangleAlert :size="11" class="icon-inline" aria-hidden="true" />
      {{ score.warnings[0] }}<span v-if="score.warnings.length > 1"> 他{{ score.warnings.length - 1 }}件</span>
    </div>
    <div v-else-if="score.reasons.length > 0" class="xs dim warnings">{{ score.reasons[0] }}</div>
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
.token-card.avoid { opacity: 0.75; }
.head { display: flex; align-items: center; gap: 8px; }
.name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.score { font-size: 1.15rem; }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 4px; }
.signals { gap: 6px; }
.sig {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 99px;
  border: 1px solid var(--border);
  font-size: 0.68rem;
}
.sig.on { color: var(--up); border-color: var(--up); }
.sig.bad { color: var(--down); border-color: var(--down); }
.sig.off { color: var(--text-faint); }
.warnings { margin-top: 5px; }
</style>
