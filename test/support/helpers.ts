import { vi } from 'vitest';

/** テスト用 API のオリジン */
export const BASE_URL = 'https://api.example.test';

/** テスト用 API の URL を作る */
export function url(path: string): string {
  return `${BASE_URL}${path}`;
}

/**
 * フェイクタイマーを有効にし、AbortSignal.timeout() をフェイクタイマーで動く実装に差し替える。
 *
 * Node の AbortSignal.timeout() は内部タイマーを使うため vi.useFakeTimers() が効かない。
 * 本体は AbortSignal.timeout() を呼び出し時に参照するので、差し替えれば実時間を待たずに検証できる。
 * 差し替えは vitest の restoreMocks で、フェイクタイマーは setup.ts でテストごとに元に戻る。
 */
export function useFakeTimeout(): void {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds: number) => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new DOMException('signal timed out', 'TimeoutError'));
    }, milliseconds);
    return controller.signal;
  });
}

/** Promise が決着したかを追跡する(reject も処理済みにする) */
export function track(promise: Promise<unknown>): { readonly settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

/**
 * reject されたエラーを返す。resolve された場合は失敗させる。
 * フェイクタイマーを進める前に呼んでおくと、未処理の reject として報告されない。
 */
export async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Promise が reject されませんでした');
}

/** 外から resolve できる Promise */
export function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 応答しない MSW のリゾルバー */
export function hang(): Promise<never> {
  return new Promise<never>(() => {});
}

/** 最初のチャンクだけ送って終わらないストリーム(ボディ読み取り中の中断の検証用) */
export function endlessStream(firstChunk: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(firstChunk));
    },
  });
}

/**
 * globalThis.fetch を監視する。
 * `responded()` は fetch がレスポンス(ヘッダー)を返したかを返すので、
 * 「ボディ読み取り中」の中断を、fetch 段階の中断と区別して検証できる。
 */
export function spyFetch(): { responded(): boolean } {
  const spy = vi.spyOn(globalThis, 'fetch');
  return {
    responded: () => spy.mock.settledResults.some((result) => result.type === 'fulfilled'),
  };
}
