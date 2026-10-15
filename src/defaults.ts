/**
 * 設定項目の既定値。既定値はこのファイルにだけ定義する。
 */
import type { ResolvedFetcherConfig } from './types.js';

/** 既定のタイムアウト(ミリ秒) */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** method を省略したときの HTTP メソッド */
export const DEFAULT_METHOD = 'GET';

/** `createFetcher` の設定の既定値。設定項目を追加したら、ここに既定値を追加する */
export const DEFAULT_CONFIG: ResolvedFetcherConfig = Object.freeze({
  timeout: DEFAULT_TIMEOUT_MS,
});
