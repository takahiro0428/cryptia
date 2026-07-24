import { defineEventHandler } from 'h3'
import type { NewsItem } from '~/shared/types'
import { getMarketNews } from '../utils/news'

/** 市場ニュース一覧（F-10）。取得失敗時は空配列（クライアント側で案内表示） */
export default defineEventHandler(async (): Promise<{ items: NewsItem[] }> => {
  return { items: await getMarketNews() }
})
