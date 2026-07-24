import { defineStore } from 'pinia'
import { STRATEGY_PRESETS } from '~/shared/strategyPresets'
import type { StrategyDoc } from '~/shared/types'
import { persist, restore } from '~/composables/usePersistence'

const STORE_KEY = 'strategies'

interface PersistedStrategies {
  customDocs: StrategyDoc[]
  activeId: string
}

/**
 * RAG 戦略設定ストア（UC-7 / F-09）。
 * プリセット（builtin・削除不可）+ ユーザー作成ドキュメントを管理し、
 * 選択中の戦略が AI 呼び出し時にプロンプトへ注入される。
 */
export const useStrategyStore = defineStore('strategy', {
  state: () => ({
    customDocs: [] as StrategyDoc[],
    activeId: STRATEGY_PRESETS[0].id,
    restored: false,
  }),
  getters: {
    allDocs(state): StrategyDoc[] {
      return [...STRATEGY_PRESETS, ...state.customDocs]
    },
    activeDoc(state): StrategyDoc {
      return this.allDocs.find((d: StrategyDoc) => d.id === state.activeId) ?? STRATEGY_PRESETS[0]
    },
  },
  actions: {
    async restoreState() {
      if (this.restored) return
      const saved = await restore<PersistedStrategies>(STORE_KEY)
      if (saved) {
        this.customDocs = saved.customDocs ?? []
        // 保存されていた activeId が存在しない場合はデフォルトに戻す
        this.activeId = this.allDocs.some((d) => d.id === saved.activeId)
          ? saved.activeId
          : STRATEGY_PRESETS[0].id
      }
      this.restored = true
    },
    _persist() {
      persist<PersistedStrategies>(STORE_KEY, {
        customDocs: this.customDocs,
        activeId: this.activeId,
      })
    },
    setActive(id: string) {
      if (!this.allDocs.some((d) => d.id === id)) return
      this.activeId = id
      this._persist()
    },
    addCustom(input: { name: string; content: string; riskLevel: number; tags?: string[] }): StrategyDoc {
      const doc: StrategyDoc = {
        id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: input.name.slice(0, 100),
        content: input.content.slice(0, 4000),
        tags: input.tags ?? [],
        builtin: false,
        riskLevel: Math.min(5, Math.max(1, Math.round(input.riskLevel))),
        updatedAt: Date.now(),
      }
      this.customDocs.push(doc)
      this._persist()
      return doc
    },
    updateCustom(id: string, patch: { name?: string; content?: string; riskLevel?: number }) {
      const doc = this.customDocs.find((d) => d.id === id)
      if (!doc) return
      if (patch.name) doc.name = patch.name.slice(0, 100)
      if (patch.content) doc.content = patch.content.slice(0, 4000)
      if (patch.riskLevel) doc.riskLevel = Math.min(5, Math.max(1, Math.round(patch.riskLevel)))
      doc.updatedAt = Date.now()
      this._persist()
    },
    removeCustom(id: string) {
      const doc = this.customDocs.find((d) => d.id === id)
      if (!doc || doc.builtin) return
      this.customDocs = this.customDocs.filter((d) => d.id !== id)
      if (this.activeId === id) this.activeId = STRATEGY_PRESETS[0].id
      this._persist()
    },
    /** プリセットを複製してカスタム化（builtin は編集不可のため） */
    duplicate(id: string): StrategyDoc | null {
      const src = this.allDocs.find((d) => d.id === id)
      if (!src) return null
      return this.addCustom({
        name: `${src.name}（コピー）`,
        content: src.content,
        riskLevel: src.riskLevel,
        tags: [...src.tags],
      })
    },
  },
})
