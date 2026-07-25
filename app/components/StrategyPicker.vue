<script setup lang="ts">
import { BookOpen } from '@lucide/vue'
import { STRATEGY_CONTEXTS, useStrategyStore, type StrategyContext } from '~/stores/strategy'

/**
 * 画面別の戦略ピッカー。各画面（AI分析/デモ/Solana魔界/実トレード）に配置し、
 * その画面で AI が従う戦略をその場で切り替えられる。
 */
const props = defineProps<{ context: StrategyContext }>()
const strategy = useStrategyStore()

const label = computed(
  () => STRATEGY_CONTEXTS.find((c) => c.key === props.context)?.label ?? props.context,
)
const current = computed(() => strategy.docFor(props.context))
</script>

<template>
  <div class="picker">
    <BookOpen :size="14" class="dim" aria-hidden="true" />
    <label class="small dim nowrap" :for="`strategy-${context}`">{{ label }}の戦略</label>
    <select
      :id="`strategy-${context}`"
      class="input picker-select"
      :value="current.id"
      @change="(e) => strategy.setActiveFor(context, (e.target as HTMLSelectElement).value)"
    >
      <option v-for="d in strategy.allDocs" :key="d.id" :value="d.id">
        {{ d.name }}{{ d.builtin ? '' : '（カスタム）' }}
      </option>
    </select>
    <NuxtLink to="/strategy" class="xs nowrap">編集 →</NuxtLink>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  margin-bottom: 12px;
}
.picker-select {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  font-size: 0.85rem;
}
</style>
