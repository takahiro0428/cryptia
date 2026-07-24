<script setup lang="ts">
import { useUiStore } from '~/stores/ui'

// 免責表示（BR-6）。初回起動時に表示し、既読後は実トレード画面のみ常設表示する。
const props = withDefaults(defineProps<{ always?: boolean }>(), { always: false })
const ui = useUiStore()
const visible = computed(() => props.always || !ui.disclaimerAcknowledged)
</script>

<template>
  <div v-if="visible" class="disclaimer" role="note">
    ⚠️ Cryptia は情報提供・シミュレーションツールであり、投資助言を行うものではありません。
    暗号資産・トークン化資産の取引には元本割れ等の重大なリスクがあります。投資判断はご自身の責任で行ってください。
    <button
      v-if="!always && !ui.disclaimerAcknowledged"
      class="btn btn-sm btn-ghost"
      type="button"
      @click="ui.acknowledgeDisclaimer()"
    >
      理解しました
    </button>
  </div>
</template>
