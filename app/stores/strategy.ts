import { defineStore } from 'pinia'
import { STRATEGY_PRESETS } from '~/shared/strategyPresets'
import type { StrategyDoc } from '~/shared/types'
import { persist, restore } from '~/composables/usePersistence'

const STORE_KEY = 'strategies'

/** 戦略を個別に設定できる画面（コンテキスト） */
export type StrategyContext = 'insights' | 'demo' | 'solana' | 'live'

export const STRATEGY_CONTEXTS: { key: StrategyContext; label: string }[] = [
  { key: 'insights', label: 'AI分析' },
  { key: 'demo', label: 'AIデモトレード' },
  { key: 'solana', label: 'Solana魔界' },
  { key: 'live', label: '実トレード' },
]

/** 画面ごとの既定戦略（用途に合うプリセットを初期値にする） */
const DEFAULT_BY_CONTEXT: Record<StrategyContext, string> = {
  insights: 'preset-momentum',
  demo: 'preset-momentum',
  solana: 'preset-degen-ladder',
  live: 'preset-dca',
}

interface PersistedStrategies {
  customDocs: StrategyDoc[]
  /** 旧形式（全画面共通）。移行用に残す */
  activeId?: string
  activeByContext?: Partial<Record<StrategyContext, string>>
}

/**
 * RAG 戦略設定ストア（UC-7 / F-09）。
 * プリセット（builtin・削除不可）+ ユーザー作成ドキュメントを管理し、
 * **画面（AI分析/デモ/Solana魔界/実トレード）ごとに選択された戦略**が
 * AI 呼び出し時にプロンプトへ注入される。
 */
export const useStrategyStore = defineStore('strategy', {
  state: () => ({
    customDocs: [] as StrategyDoc[],
    activeByContext: { ...DEFAULT_BY_CONTEXT } as Record<StrategyContext, string>,
    restored: false,
  }),
  getters: {
    allDocs(state): StrategyDoc[] {
      return [...STRATEGY_PRESETS, ...state.customDocs]
    },
    /** 画面別の適用戦略（未設定・消失時は画面既定 → 先頭プリセット） */
    docFor() {
      return (context: StrategyContext): StrategyDoc => {
        const id = this.activeByContext[context]
        return (
          this.allDocs.find((d: StrategyDoc) => d.id === id) ??
          this.allDocs.find((d: StrategyDoc) => d.id === DEFAULT_BY_CONTEXT[context]) ??
          STRATEGY_PRESETS[0]
        )
      }
    },
  },
  actions: {
    async restoreState() {
      if (this.restored) return
      const saved = await restore<PersistedStrategies>(STORE_KEY)
      if (saved) {
        this.customDocs = saved.customDocs ?? []
        if (saved.activeByContext) {
          for (const { key } of STRATEGY_CONTEXTS) {
            const id = saved.activeByContext[key]
            if (id && this.allDocs.some((d) => d.id === id)) this.activeByContext[key] = id
          }
        } else if (saved.activeId && this.allDocs.some((d) => d.id === saved.activeId)) {
          // 旧形式（全画面共通の activeId）からの移行: 全画面へ引き継ぐ（原則7: 下位互換）
          for (const { key } of STRATEGY_CONTEXTS) this.activeByContext[key] = saved.activeId
        }
      }
      this.restored = true
    },
    _persist() {
      persist<PersistedStrategies>(STORE_KEY, {
        customDocs: this.customDocs,
        activeByContext: { ...this.activeByContext },
      })
    },
    /** 画面別に戦略を適用する */
    setActiveFor(context: StrategyContext, id: string) {
      if (!this.allDocs.some((d) => d.id === id)) return
      this.activeByContext[context] = id
      this._persist()
    },
    /** 全画面に一括適用する */
    setActiveAll(id: string) {
      if (!this.allDocs.some((d) => d.id === id)) return
      for (const { key } of STRATEGY_CONTEXTS) this.activeByContext[key] = id
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
      // 削除された戦略を適用中の画面は、その画面の既定戦略へ戻す
      for (const { key } of STRATEGY_CONTEXTS) {
        if (this.activeByContext[key] === id) {
          this.activeByContext[key] = DEFAULT_BY_CONTEXT[key]
        }
      }
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
