/**
 * ボットウォレット（専用トレード用ウォレット）の鍵保護（F-13）。
 * - 秘密鍵はパスフレーズ由来鍵（PBKDF2-SHA256）で AES-GCM 暗号化し、**この端末の
 *   localStorage にのみ**保存する（Firestore へは決して同期しない: BR-1 改訂の中核）
 * - 復号は自動実行の開始時のみ行い、平文鍵はメモリ上（モジュール変数）だけに置く
 * - GCM の認証タグにより、パスフレーズ誤りは復号失敗として確実に検出される
 */

/** PBKDF2 反復回数（OWASP 推奨水準。端末内総当たりの遅延が目的） */
const PBKDF2_ITERATIONS = 310_000

export interface EncryptedSecretKey {
  v: 1
  /** base64 */
  salt: string
  /** base64 */
  iv: string
  /** base64（AES-GCM 暗号文 + 認証タグ） */
  data: string
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

/** Base58 エンコード（秘密鍵バックアップの表示用。Phantom 等のインポート形式と互換） */
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export function bytesToBase58(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = '1' + out
  }
  return out
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * 秘密鍵をパスフレーズで暗号化する（保存用）。
 * aad（追加認証データ）に公開鍵・出金先アドレス等の平文メタデータを束縛すると、
 * localStorage 上での書き換え（出金先すり替え等）が復号失敗として検出される
 * （ISSUE-P9-M17。実行中のスクリプト注入は防げない — 残存リスクとして文書化）。
 */
export async function encryptSecretKey(
  secretKey: Uint8Array,
  passphrase: string,
  aad = '',
): Promise<EncryptedSecretKey> {
  if (passphrase.length < 8) {
    throw new Error('パスフレーズは 8 文字以上にしてください')
  }
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt)
  const cipher = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      additionalData: new TextEncoder().encode(aad) as BufferSource,
    },
    key,
    secretKey as BufferSource,
  )
  return { v: 1, salt: bytesToB64(salt), iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(cipher)) }
}

/**
 * 秘密鍵を復号する。パスフレーズ誤り・データ破損・aad（平文メタデータ）の
 * 改竄は例外（GCM 認証失敗）。返り値はメモリ上でのみ扱い、状態ストアや永続化に入れないこと。
 */
export async function decryptSecretKey(
  enc: EncryptedSecretKey,
  passphrase: string,
  aad = '',
): Promise<Uint8Array> {
  const key = await deriveKey(passphrase, b64ToBytes(enc.salt))
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: b64ToBytes(enc.iv) as BufferSource,
        additionalData: new TextEncoder().encode(aad) as BufferSource,
      },
      key,
      b64ToBytes(enc.data) as BufferSource,
    )
    return new Uint8Array(plain)
  } catch {
    throw new Error('パスフレーズが違うか、鍵データが破損・改竄されています')
  }
}
