<script setup lang="ts">
import type { StrategyDoc } from '~/shared/types'
import { useStrategyStore } from '~/stores/strategy'
import { useUiStore } from '~/stores/ui'

// RAG 戦略設定（UC-7 / F-09）
const strategy = useStrategyStore()
const ui = useUiStore()

const editing = ref<StrategyDoc | null>(null)
const form = reactive({ name: '', content: '', riskLevel: 3 })
const showForm = ref(false)

function startCreate() {
  editing.value = null
  form.name = ''
  form.content = ''
  form.riskLevel = 3
  showForm.value = true
}

function startEdit(doc: StrategyDoc) {
  if (doc.builtin) {
    const copy = strategy.duplicate(doc.id)
    if (copy) {
      ui.notify(`プリセットを「${copy.name}」として複製しました。複製を編集できます`)
      editing.value = copy
      form.name = copy.name
      form.content = copy.content
      form.riskLevel = copy.riskLevel
      showForm.value = true
    }
    return
  }
  editing.value = doc
  form.name = doc.name
  form.content = doc.content
  form.riskLevel = doc.riskLevel
  showForm.value = true
}

function save() {
  if (!form.name.trim() || !form.content.trim()) {
    ui.notify('戦略名とルール内容を入力してください', 'warn')
    return
  }
  if (editing.value) {
    strategy.updateCustom(editing.value.id, { ...form })
    ui.notify('戦略を更新しました')
  } else {
    const doc = strategy.addCustom({ ...form })
    strategy.setActive(doc.id)
    ui.notify(`戦略「${doc.name}」を追加し、有効化しました`)
  }
  showForm.value = false
}

function remove(doc: StrategyDoc) {
  strategy.removeCustom(doc.id)
  ui.notify(`戦略「${doc.name}」を削除しました`)
}

onMounted(() => void strategy.restoreState())
useHead({ title: '戦略設定 | Cryptia' })

const RISK_LABELS = ['', '保守的', 'やや保守', '標準', '積極的', '超積極的']
</script>

<template>
  <div>
    <div class="card-title">
      <h1>RAG 戦略設定</h1>
      <button class="btn btn-primary btn-sm" type="button" @click="startCreate">＋ 新規戦略</button>
    </div>
    <p class="small dim">
      選択した戦略ドキュメントが AI のプロンプトに注入され、インサイト・デモトレード・実トレードの判断が変わります。
      プリセットは複製してカスタマイズできます。
    </p>

    <!-- 戦略編集フォーム -->
    <section v-if="showForm" class="card" style="border-color: var(--accent)">
      <h2>{{ editing ? '戦略を編集' : '新しい戦略' }}</h2>
      <label class="field">
        <span>戦略名</span>
        <input v-model="form.name" class="input" maxlength="100" placeholder="例: 押し目買いスイング" />
      </label>
      <label class="field">
        <span>ルール内容（自然言語で記述。AI がこの内容に従います）</span>
        <textarea
          v-model="form.content"
          class="input"
          rows="7"
          maxlength="4000"
          placeholder="例:&#10;- RSI 40 以下への押し目で分割買いする&#10;- +15% で半分利確、-10% で損切りする&#10;- 1銘柄への投入は総資産の 15% まで"
        />
      </label>
      <label class="field">
        <span>リスク許容度: {{ form.riskLevel }}（{{ RISK_LABELS[form.riskLevel] }}）</span>
        <input v-model.number="form.riskLevel" type="range" min="1" max="5" step="1" style="width: 100%" />
      </label>
      <div style="display: flex; gap: 8px">
        <button class="btn btn-primary" type="button" @click="save">保存</button>
        <button class="btn btn-ghost" type="button" @click="showForm = false">キャンセル</button>
      </div>
    </section>

    <!-- 戦略一覧 -->
    <div class="grid grid-2" style="margin-top: 12px">
      <div
        v-for="doc in strategy.allDocs"
        :key="doc.id"
        class="card strategy-card"
        :class="{ active: doc.id === strategy.activeId }"
      >
        <div class="card-title">
          <h2>
            {{ doc.name }}
            <span v-if="doc.builtin" class="badge">プリセット</span>
            <span v-else class="badge badge-accent">カスタム</span>
          </h2>
          <span class="badge" :class="doc.riskLevel >= 4 ? 'badge-down' : doc.riskLevel <= 2 ? 'badge-up' : 'badge-warn'">
            リスク {{ doc.riskLevel }}/5
          </span>
        </div>
        <pre class="content small dim">{{ doc.content }}</pre>
        <div class="actions">
          <button
            class="btn btn-sm"
            :class="doc.id === strategy.activeId ? 'btn-success' : 'btn-primary'"
            type="button"
            :disabled="doc.id === strategy.activeId"
            @click="strategy.setActive(doc.id)"
          >
            {{ doc.id === strategy.activeId ? '✓ 適用中' : 'この戦略を使う' }}
          </button>
          <button class="btn btn-sm btn-ghost" type="button" @click="startEdit(doc)">
            {{ doc.builtin ? '複製して編集' : '編集' }}
          </button>
          <button v-if="!doc.builtin" class="btn btn-sm btn-ghost down" type="button" @click="remove(doc)">
            削除
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.strategy-card.active { border-color: var(--up); }
.content {
  white-space: pre-wrap;
  font-family: inherit;
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  max-height: 180px;
  overflow-y: auto;
  margin: 0 0 10px;
}
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
