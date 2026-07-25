<script setup lang="ts">
import { useUiStore } from '~/stores/ui'

const ui = useUiStore()
</script>

<template>
  <div class="app-shell">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
    <!-- グローバル通知（エラーコード付きトースト・タップで即時クローズ） -->
    <div class="toast-region" role="status" aria-live="polite">
      <div
        v-for="t in ui.toasts"
        :key="t.id"
        class="toast"
        :class="t.kind"
        role="button"
        tabindex="0"
        @click="ui.dismiss(t.id)"
        @keydown.enter="ui.dismiss(t.id)"
      >
        <span v-if="t.code" class="mono xs faint">{{ t.code }}</span>
        {{ t.message }}
      </div>
    </div>
  </div>
</template>
