<script setup lang="ts">
import { Check, ClipboardCopy, Eye, EyeOff } from '@lucide/vue'
import { useUiStore } from '~/stores/ui'

/**
 * トークンの CA（コントラクトアドレス = ミント）をその場で確認・コピーする行。
 * ページ遷移せずカード内で完結する（トークンカード共通部品）。
 */
const props = defineProps<{ address: string; label?: string }>()

const ui = useUiStore()
const expanded = ref(false)
const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null

const caLabel = computed(() => props.label ?? 'CA')
const short = computed(() => `${props.address.slice(0, 4)}…${props.address.slice(-4)}`)
/** 展開領域と aria-controls で紐付けるための一意 ID（アドレスはカード単位で一意） */
const fullId = computed(() => `ca-full-${props.address.slice(0, 12)}`)

async function copy() {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(props.address)
    } else {
      // 非セキュアコンテキスト・旧ブラウザ向けフォールバック
      const ta = document.createElement('textarea')
      ta.value = props.address
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      try {
        ta.select()
        // execCommand は失敗時に false を返す（偽の「コピー済み」表示を防ぐ）
        if (!document.execCommand('copy')) throw new Error('execCommand copy failed')
      } finally {
        // throw 時も不可視 textarea を残さない（フォーカス迷子の防止）
        ta.remove()
      }
    }
    copied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => (copied.value = false), 1800)
  } catch {
    ui.notify('コピーできませんでした。アドレスを表示して長押しで選択してください', 'warn')
  }
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer)
})
</script>

<template>
  <div>
    <div class="ca-row">
      <button
        class="ca-btn"
        type="button"
        :aria-expanded="expanded"
        :aria-controls="fullId"
        :aria-label="`${caLabel} を${expanded ? '隠す' : '表示'}`"
        @click="expanded = !expanded"
      >
        <component :is="expanded ? EyeOff : Eye" :size="12" aria-hidden="true" />
        {{ caLabel }}: <span class="mono">{{ short }}</span>
      </button>
      <!-- aria-label を状態連動にし、支援技術にもコピー成功を伝える -->
      <button
        class="ca-btn"
        :class="{ done: copied }"
        type="button"
        :aria-label="copied ? `${caLabel} をコピーしました` : `${caLabel} をコピー`"
        @click="copy"
      >
        <component :is="copied ? Check : ClipboardCopy" :size="12" aria-hidden="true" />
        {{ copied ? 'コピー済み' : 'コピー' }}
      </button>
    </div>
    <!-- 全文表示（タップ選択でも扱えるよう monospace + 折返し） -->
    <div v-if="expanded" :id="fullId" class="ca-full mono">{{ address }}</div>
  </div>
</template>

<style scoped>
.ca-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ca-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 99px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-dim);
  font-size: 0.68rem;
  cursor: pointer;
  min-height: 26px;
}
.ca-btn:hover { color: var(--text); }
.ca-btn.done { color: var(--up); border-color: var(--up); }
.ca-full {
  margin-top: 5px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: var(--bg);
  font-size: 0.68rem;
  word-break: break-all;
  user-select: all;
}
</style>
