import type { StrategyDoc } from './types'

/**
 * デフォルトのトレード戦術プリセット（RAG 戦略ドキュメント）。
 * AI 呼び出し時に選択中の戦略 content がプロンプトへ注入され、AI の挙動を変える。
 * builtin: true のドキュメントは削除不可（ユーザーは複製してカスタムできる）。
 */
export const STRATEGY_PRESETS: StrategyDoc[] = [
  {
    id: 'preset-momentum',
    name: '順張りモメンタム',
    content: [
      'トレンドフォロー戦略。上昇トレンドが確認できた銘柄のみ買う。',
      '- RSI が 55〜75 かつ短期モメンタムがプラスのときに買い増しを検討する',
      '- RSI が 80 を超えたら過熱とみなし新規買いを止め、一部利確を検討する',
      '- 高値から 8% 下落したらトレンド崩れとみなし撤退する',
      '- 1銘柄への投入は総資産の 20% を上限とする',
    ].join('\n'),
    tags: ['momentum', 'trend', '順張り', 'モメンタム'],
    builtin: true,
    riskLevel: 3,
    updatedAt: 0,
  },
  {
    id: 'preset-reversal',
    name: '逆張りリバーサル',
    content: [
      '売られすぎからの反発を狙う平均回帰戦略。',
      '- RSI が 30 未満に売り込まれた銘柄を分割で拾う',
      '- 平均取得単価から +10% で半分利確、+20% で全利確する',
      '- 想定に反して -12% となったら損切りする',
      '- 出来高が枯れている銘柄（24h 出来高が時価総額の 1% 未満）は対象外とする',
    ].join('\n'),
    tags: ['reversal', 'rsi', '逆張り', 'リバーサル'],
    builtin: true,
    riskLevel: 3,
    updatedAt: 0,
  },
  {
    id: 'preset-dca',
    name: 'DCA 積立（防御的）',
    content: [
      '時間分散のドルコスト平均法。相場観に依存せず淡々と積み立てる。',
      '- 主要銘柄（BTC/ETH/SOL/PAXG）のみを対象とする',
      '- 1回の買付は総資産の 5% 以下の小口で行う',
      '- 急騰局面（24h +10% 超）では買付を見送る',
      '- 売却は原則行わない。リバランス目的でのみ一部売却を許可する',
    ].join('\n'),
    tags: ['dca', '積立', '防御', '長期'],
    builtin: true,
    riskLevel: 1,
    updatedAt: 0,
  },
  {
    id: 'preset-breakout',
    name: 'ブレイクアウト追撃',
    content: [
      '直近レンジの上抜けを追う短期戦略。',
      '- 直近 7 日高値を出来高を伴って更新した銘柄を買う',
      '- 利確はトレーリングで行う: 直近高値から 6% 押したら決済する',
      '- ダマシ対策として、ブレイク後に始値を割ったら即時撤退する',
      '- 同時保有は最大 3 銘柄までとする',
    ].join('\n'),
    tags: ['breakout', '高値更新', '短期'],
    builtin: true,
    riskLevel: 4,
    updatedAt: 0,
  },
  {
    id: 'preset-degen-ladder',
    name: '魔界ラダー利確（Solana 草コイン向け）',
    content: [
      'Solana 新興トークン向けの機械的ラダー戦略。感情を排し利確を徹底する。',
      '- エントリーは流動性 5 万ドル以上・ペア年齢 24 時間以上のトークンに限る',
      '- +100% 到達で保有の 50% を利確する（元本回収を最優先）',
      '- +300% 到達でさらに 50%（残の半分）を利確する',
      '- -30% で全量損切りする。ナンピンは禁止する',
      '- 1トークンへの投入は割当資金の 10% を上限とする',
    ].join('\n'),
    tags: ['solana', 'degen', 'ladder', '草コイン', '魔界', 'ラダー'],
    builtin: true,
    riskLevel: 5,
    updatedAt: 0,
  },
]

/**
 * キーワード RAG: 問い合わせ文脈に関連する戦略ドキュメントを選択する。
 * MVP はタグ・本文のキーワード一致スコア。将来 Vertex AI Embeddings に置換する
 * （tech-stack-decision.md 参照）。
 */
export function retrieveStrategies(
  docs: StrategyDoc[],
  query: string,
  limit = 2,
): StrategyDoc[] {
  const terms = query
    .toLowerCase()
    .split(/[\s,、。/]+/)
    .filter((t) => t.length >= 2)
  if (terms.length === 0) return docs.slice(0, limit)
  const scored = docs.map((d) => {
    const haystack = `${d.name} ${d.tags.join(' ')} ${d.content}`.toLowerCase()
    const score = terms.reduce((s, t) => s + (haystack.includes(t) ? 1 : 0), 0)
    return { d, score }
  })
  return scored
    .sort((a, b) => b.score - a.score)
    .filter((s) => s.score > 0)
    .slice(0, limit)
    .map((s) => s.d)
}
