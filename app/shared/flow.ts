import type { FundFlow, FlowPeriod, Ticker } from './types'
import { clamp } from './ta'

/**
 * 銘柄間の資金フロー推定。
 *
 * 【推定モデル（ヒューリスティック）】
 * オンチェーン・取引所間の実フローはリアルタイム公開データが存在しないため、
 * 「出来高加重の相対モメンタム差」で銘柄間フローを推定する:
 *   - 期間内の変動率がプラスの銘柄は資金流入側、マイナスは流出側とみなす
 *   - 流出銘柄 → 流入銘柄 に対し、両者の出来高と勢い差に比例したフローを配分する
 * これは可視化のための推定値であり、UI 上でも「推定」と明示する。
 */
export function estimateFlows(tickers: Ticker[], period: FlowPeriod): FundFlow[] {
  const changeOf = (t: Ticker) =>
    period === '1h' ? t.change1hPct : period === '24h' ? t.change24hPct : t.change7dPct

  const active = tickers.filter((t) => t.volume24hUsd > 0)
  if (active.length < 2) return []

  // 出来高加重の勢いスコア。正=流入 負=流出
  const scores = active.map((t) => ({
    t,
    score: changeOf(t) * Math.log10(1 + t.volume24hUsd),
  }))

  const inflows = scores.filter((s) => s.score > 0)
  const outflows = scores.filter((s) => s.score < 0)
  if (inflows.length === 0 || outflows.length === 0) return []

  const totalIn = inflows.reduce((s, v) => s + v.score, 0)
  const totalOut = outflows.reduce((s, v) => s - v.score, 0)

  const flows: FundFlow[] = []
  for (const out of outflows) {
    // 流出銘柄の「動いた出来高」の一部が流出したとみなす
    const movedUsd = out.t.volume24hUsd * clamp(Math.abs(changeOf(out.t)) / 100, 0, 0.5)
    // 流出全体に占める本銘柄の割合で正規化
    const outWeight = -out.score / totalOut
    for (const inn of inflows) {
      const inWeight = inn.score / totalIn
      const amountUsd = movedUsd * inWeight * clamp(outWeight + 0.5, 0.5, 1.5)
      if (amountUsd <= 0) continue
      flows.push({ fromAssetId: out.t.assetId, toAssetId: inn.t.assetId, amountUsd })
    }
  }

  // 描画負荷を抑えるため上位のみ返す（NFR: バブルマップ 60fps 目標）
  return flows.sort((a, b) => b.amountUsd - a.amountUsd).slice(0, 24)
}

/** 銘柄別の純流入額（バブルタップ時の内訳パネル用） */
export function netFlowByAsset(flows: FundFlow[]): Map<string, { inUsd: number; outUsd: number }> {
  const map = new Map<string, { inUsd: number; outUsd: number }>()
  const entry = (id: string) => {
    let e = map.get(id)
    if (!e) {
      e = { inUsd: 0, outUsd: 0 }
      map.set(id, e)
    }
    return e
  }
  for (const f of flows) {
    entry(f.toAssetId).inUsd += f.amountUsd
    entry(f.fromAssetId).outUsd += f.amountUsd
  }
  return map
}
