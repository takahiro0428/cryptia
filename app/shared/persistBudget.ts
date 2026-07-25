/**
 * 永続化ペイロードの容量保護（AUDIT-P9-1）。
 * Firestore の状態ドキュメントは Rules で json < 262144 バイトに制限されるため、
 * 件数ベースの上限（アーカイブ数・orders 件数）だけでは超過し得る。
 * 保存前に実測サイズで収まることを保証し、超過時は
 *   1) 古いアーカイブから約定明細（orders）を落とす
 *   2) それでも超過なら古いアーカイブ自体を落とす（最新 1 件は必ず残す)
 * の順で切り詰める。実行中ポートフォリオ（追記型の主記録: BR-7）には手を付けない。
 */

import type { Portfolio } from './types'

/** 保存ペイロードの目標上限（バイト）。Rules 上限 262144 に対し余裕を持たせる */
export const PERSIST_BUDGET_BYTES = 200_000

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null

/** UTF-8 バイト数（Rules の上限判定と同等以上に保守的な実測） */
export function utf8Bytes(json: string): number {
  return encoder ? encoder.encode(json).length : json.length * 3
}

/**
 * 実行中セッション列を予算内に収める（複数セッション対応: ISSUE-P9-H3）。
 * ペイロードの主体はアーカイブではなく実行中セッションの orders / equityCurve に
 * なり得るため、超過時は**永続化コピーの**約定履歴・資産推移を段階的に絞る
 * （メモリ上の実行中データ・アーカイブ保存（直近100件）には影響しない。
 * リロード時に古い明細の一部が省略され得ることは設計判断として文書化）。
 * アーカイブの明細を削る前にこちらを先に適用し、保護対象の記録（BR-7）を温存する。
 */
export function fitSessionsToBudget<S extends { portfolio: Portfolio }>(
  sessions: S[],
  measure: (sessions: S[]) => number,
  budget = PERSIST_BUDGET_BYTES,
): S[] {
  let current = sessions
  // 約定履歴の永続化件数を段階的に絞る（equityCurve も併せて間引く）
  for (const cap of [400, 200, 100, 50, 25]) {
    if (measure(current) <= budget) return current
    current = current.map((s) => ({
      ...s,
      portfolio: {
        ...s.portfolio,
        orders: s.portfolio.orders.slice(-cap),
        equityCurve: s.portfolio.equityCurve.slice(-Math.min(cap * 2, 200)),
      },
    }))
  }
  return current
}

/**
 * アーカイブ列を予算内に収める。measure はアーカイブ列を差し替えた
 * ペイロード全体のシリアライズ後バイト数を返す関数。
 */
export function fitArchivesToBudget<A extends { orders?: unknown[] }>(
  archives: A[],
  measure: (archives: A[]) => number,
  budget = PERSIST_BUDGET_BYTES,
): A[] {
  let current = archives
  if (measure(current) <= budget) return current
  // 1) 古い順に約定明細を落とす（サマリーは保持 = 記録の巻き戻り最小化: 原則2）
  for (let i = current.length - 1; i >= 0; i--) {
    if (!current[i].orders?.length) continue
    current = current.map((a, j) => (j === i ? { ...a, orders: undefined } : a))
    if (measure(current) <= budget) return current
  }
  // 2) それでも超過なら古いアーカイブごと落とす（最新 1 件は必ず残す）
  while (current.length > 1 && measure(current) > budget) {
    current = current.slice(0, -1)
  }
  return current
}
