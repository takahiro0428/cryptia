import { defineEventHandler } from 'h3'
import {
  DEX_SEARCH_BASE,
  discoverFreshPairs,
  extractSnsSignals,
  toToken,
  type DexPair,
} from '~/shared/dexscreener'
import { countDuplicates, SNIPE_MAX_AGE_HOURS, type FreshTokenSignals } from '~/shared/snipeScoring'
import type { SolanaToken } from '~/shared/types'
import { cachedProxyJson, fetchUpstreamJson } from '../../utils/dexProxy'

/** 新規上場リストのキャッシュ有効期間（上流負荷と鮮度のバランス） */
const TTL_MS = 90_000
/** 再発行照合の検索回数上限（上流レートリミット配慮） */
const MAX_DUP_SEARCHES = 8
/** パイプライン最大 11 回の上流呼び出し見積り（profiles 1 + tokens 2 + 検索 8） */
const UPSTREAM_COST = 11
/**
 * パイプライン全体のデッドライン。クライアントのタイムアウト（25s）内に必ず応答するため、
 * 超過が見込まれる段階（RPC・再発行照合）はスキップしシグナル null の部分結果で返す（AUDIT-P9-5）
 */
const DEADLINE_MS = 20_000
const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com'
const RPC_TIMEOUT_MS = 8_000

interface FreshItem {
  token: SolanaToken
  signals: FreshTokenSignals
}

interface RpcMintInfo {
  mintAuthority?: string | null
  freezeAuthority?: string | null
}

/**
 * Solana RPC で mint / freeze 権限を一括取得する（dev がラグ手段を放棄済みか）。
 * 失敗しても全体は止めず、該当シグナルを null（未取得）にする（原則4）。
 */
async function fetchMintAuthorities(
  mints: string[],
): Promise<Map<string, { mintRenounced: boolean; freezeAbsent: boolean }>> {
  const result = new Map<string, { mintRenounced: boolean; freezeAbsent: boolean }>()
  if (mints.length === 0) return result
  try {
    const res = await fetch(SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getMultipleAccounts',
        params: [mints, { encoding: 'jsonParsed' }],
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
    if (!res.ok) return result
    const data = (await res.json()) as {
      result?: { value?: ({ data?: { parsed?: { type?: string; info?: RpcMintInfo } } } | null)[] }
    }
    const values = data.result?.value ?? []
    mints.forEach((mint, i) => {
      const parsed = values[i]?.data?.parsed
      if (parsed?.type === 'mint' && parsed.info) {
        result.set(mint, {
          mintRenounced: parsed.info.mintAuthority == null,
          freezeAbsent: parsed.info.freezeAuthority == null,
        })
      }
    })
  } catch {
    /* RPC 失敗時はシグナル未取得のまま返す */
  }
  return result
}

/**
 * 新規上場トークンの発見 + シグナル収集（GET /api/solana/fresh）。
 * 発見パイプラインは shared/dexscreener.ts、スコアリングは shared/snipeScoring.ts で
 * クライアントと共通化し、本ルートはサーバーでしか取れない詳細シグナル
 * （mint/freeze 権限・再発行照合）を付加する。
 */
export default defineEventHandler(async (event) => {
  return cachedProxyJson(
    event,
    { key: 'fresh', ttlMs: TTL_MS, upstream: 'dexscreener', upstreamCost: UPSTREAM_COST },
    async (): Promise<{ items: FreshItem[] }> => {
    const startedAt = Date.now()
    const withinDeadline = () => Date.now() - startedAt < DEADLINE_MS
    const discovered = await discoverFreshPairs(
      (url) => fetchUpstreamJson(url),
      SNIPE_MAX_AGE_HOURS,
    )

    // mint / freeze 権限（1 回の RPC で一括取得。デッドライン超過時はスキップ = null）
    const authorities = withinDeadline()
      ? await fetchMintAuthorities(discovered.map((d) => d.mint))
      : new Map<string, { mintRenounced: boolean; freezeAbsent: boolean }>()

    // 同名・同シンボル再発行の照合（検索回数は上限内で。失敗・未実施・デッドライン超過は null）
    const dupBySymbol = new Map<
      string,
      { baseSymbol: string; baseName: string; baseAddress: string; ageHours: number }[]
    >()
    const symbols = withinDeadline()
      ? [...new Set(discovered.map((d) => d.token.baseSymbol.toLowerCase()))].slice(
          0,
          MAX_DUP_SEARCHES,
        )
      : []
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const data = await fetchUpstreamJson<{ pairs?: DexPair[] }>(
            `${DEX_SEARCH_BASE}${encodeURIComponent(symbol)}`,
          )
          dupBySymbol.set(
            symbol,
            (data.pairs ?? [])
              .filter((p) => p.chainId === 'solana')
              .map(toToken)
              .filter((t): t is SolanaToken => t !== null)
              .map((t) => ({
                baseSymbol: t.baseSymbol,
                baseName: t.baseName,
                baseAddress: t.baseAddress,
                ageHours: t.ageHours,
              })),
          )
        } catch {
          /* 照合失敗 = null のまま（誤った断定をしない） */
        }
      }),
    )

    const items: FreshItem[] = discovered.map(({ mint, pair, token, profile }) => {
      const auth = authorities.get(mint)
      const dupCandidates = dupBySymbol.get(token.baseSymbol.toLowerCase())
      const h24 = pair.txns?.h24
      return {
        token,
        signals: {
          ...extractSnsSignals(pair.info, profile?.links),
          mintAuthorityRenounced: auth?.mintRenounced ?? null,
          freezeAuthorityAbsent: auth?.freezeAbsent ?? null,
          duplicateCount: dupCandidates ? countDuplicates(dupCandidates, token) : null,
          buys24h: h24?.buys ?? 0,
          sells24h: h24?.sells ?? 0,
        },
      }
    })
    return { items }
    },
  )
})
