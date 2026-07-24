<script setup lang="ts">
import { CircleUserRound, Link2 } from '@lucide/vue'
import { formatError } from '~/shared/errors'
import { useFirebase, type AccountInfo } from '~/composables/useFirebase'
import { useUiStore } from '~/stores/ui'

/**
 * アカウント連携（AUDIT-9 本対応）。
 * 匿名アカウントを Google にリンクして、端末変更・データ消去後もデータへ
 * 到達できるようにする（uid は変わらないため既存データはそのまま引き継がれる）。
 * Firebase 未設定環境では何も表示しない。
 */
const ui = useUiStore()
const available = ref(false)
const info = ref<AccountInfo>({ isAnonymous: true, email: null })
const linking = ref(false)

onMounted(async () => {
  const ctx = await useFirebase()
  if (ctx) {
    available.value = true
    info.value = ctx.accountInfo()
    // リダイレクト連携から復帰した際のエラーを通知（ISSUE-P8-14）
    const linkError = ctx.consumeLinkError()
    if (linkError) ui.notify(linkError, 'error', 'CRYPTIA-E602')
  }
})

async function link() {
  linking.value = true
  try {
    const ctx = await useFirebase()
    if (!ctx) return
    info.value = await ctx.linkWithGoogle()
    ui.notify('Google アカウントと連携しました。端末を変えてもデータを引き継げます')
  } catch (err) {
    const { code, message } = formatError(err)
    ui.notify(message, 'error', code)
  } finally {
    linking.value = false
  }
}
</script>

<template>
  <section v-if="available" class="card">
    <div class="card-title">
      <h2><CircleUserRound :size="17" class="icon-inline" aria-hidden="true" />アカウント</h2>
      <span class="badge" :class="info.isAnonymous ? 'badge-warn' : 'badge-up'">
        {{ info.isAnonymous ? '匿名（未連携）' : '連携済み' }}
      </span>
    </div>
    <template v-if="info.isAnonymous">
      <p class="small dim">
        現在は匿名アカウントのため、ブラウザのデータ消去や端末変更で戦略・取引履歴に
        アクセスできなくなります。Google アカウントと連携すると、同じデータを引き継いだまま
        どの端末からも利用できます。
      </p>
      <button class="btn btn-primary btn-sm" type="button" :disabled="linking" @click="link">
        <Link2 :size="15" aria-hidden="true" />
        {{ linking ? '連携中…' : 'Google アカウントと連携' }}
      </button>
    </template>
    <p v-else class="small dim" style="margin: 0">{{ info.email }} と連携済みです。</p>
  </section>
</template>
