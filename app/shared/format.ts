/** 表示フォーマット共通関数（UI 全画面で再利用: 原則3） */

/** USD 価格。桁に応じて小数精度を変える（草コインの極小価格に対応） */
export function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  if (abs >= 1) return `$${v.toFixed(2)}`
  if (abs >= 0.01) return `$${v.toFixed(4)}`
  if (abs === 0) return '$0'
  return `$${v.toPrecision(3)}`
}

/** 騰落率。符号付き */
export function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

/** 数量。 */
export function fmtQty(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (Math.abs(v) >= 1) return v.toFixed(4)
  return v.toPrecision(4)
}

/** 日時（日本語ロケール・短縮） */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 相対時間（例: 3分前） */
export function fmtAgo(ts: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000))
  if (sec < 60) return `${sec}秒前`
  if (sec < 3600) return `${Math.floor(sec / 60)}分前`
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間前`
  return `${Math.floor(sec / 86400)}日前`
}
