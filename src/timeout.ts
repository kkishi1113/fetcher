/**
 * タイムアウトと中断(AbortSignal)の扱い。
 *
 * - タイムアウトは `AbortSignal.timeout()` で作り、呼び出し側の signal と `AbortSignal.any()` で合成する
 * - 中断後に、タイムアウトと呼び出し側のキャンセルのどちらが原因かを判定する
 */
import type { TimeoutOption } from './types.js';

/** 中断の原因 */
export type AbortCause =
  | { readonly type: 'timeout'; readonly timeout: number }
  | { readonly type: 'abort' };

/** 1 回のリクエストに使うシグナル */
export interface RequestSignal {
  /** fetch に渡す合成済みのシグナル。タイムアウトも呼び出し側の signal もない場合は undefined */
  readonly signal: AbortSignal | undefined;
  /** 中断済みならその原因を返す。中断されていなければ undefined */
  abortCause(): AbortCause | undefined;
}

/**
 * タイムアウトの値を検証する。
 * @throws {RangeError} 正の有限数でも false でもない場合(0 を「無効」の意味で書いた誤りもここで検出する)
 */
export function validateTimeout(timeout: TimeoutOption): TimeoutOption {
  if (timeout === false) return false;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError(
      `timeout must be a positive finite number of milliseconds or false, but got ${String(timeout)}`,
    );
  }
  return timeout;
}

/**
 * 呼び出し側の signal とタイムアウトを合成する。
 * @param callerSignal - 呼び出し側の signal
 * @param timeout - 検証済みのタイムアウト。false なら付けない
 */
export function createRequestSignal(
  callerSignal: AbortSignal | null | undefined,
  timeout: TimeoutOption,
): RequestSignal {
  const timeoutSignal = timeout === false ? undefined : AbortSignal.timeout(timeout);
  const sources = [callerSignal ?? undefined, timeoutSignal].filter(
    (source): source is AbortSignal => source !== undefined,
  );
  const signal = sources.length > 1 ? AbortSignal.any(sources) : sources[0];

  return {
    signal,
    abortCause() {
      if (signal === undefined || !signal.aborted) return undefined;
      // AbortSignal.any() は最初に中断した入力の reason を引き継ぐため、reason の同一性で
      // 「先に中断したのはどちらか」を判定できる(両方が中断済みでも取り違えない)
      if (timeout !== false && timeoutSignal?.aborted === true && signal.reason === timeoutSignal.reason) {
        return { type: 'timeout', timeout };
      }
      return { type: 'abort' };
    },
  };
}

/**
 * signal が中断されたら、promise の完了を待たずに `signal.reason` で reject する。
 *
 * ブラウザでは fetch の signal がボディの読み取りにも伝播するが、MSW のモックなど
 * 伝播しない実装もあるため、ボディ読み取りが中断後もハングしないようにする保険として使う。
 */
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    // 中断で先に reject した後も、元の promise の失敗は必ずここで受けて未処理の reject を残さない
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
