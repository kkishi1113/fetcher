/**
 * fetcher が投げるエラーの定義。
 *
 * すべて {@link FetcherError} を継承し、`instanceof` または `name` で種類を判別できる。
 * 元のエラーは `cause` に保持する。
 *
 * | クラス           | name             | 発生条件                                   |
 * | ---------------- | ---------------- | ------------------------------------------ |
 * | `HttpError`      | `'HttpError'`    | `response.ok` が false                     |
 * | `NetworkError`   | `'NetworkError'` | 通信エラー(fetch の TypeError など)       |
 * | `TimeoutError`   | `'TimeoutError'` | fetcher のタイムアウト                     |
 * | `AbortError`     | `'AbortError'`   | 呼び出し側の signal による中断             |
 * | `ParseError`     | `'ParseError'`   | レスポンスボディの解析失敗                 |
 */

/** すべてのエラーに共通する初期化パラメーター */
export interface FetcherErrorInit {
  /** リクエスト先の URL */
  readonly url: string;
  /** HTTP メソッド(大文字) */
  readonly method: string;
  /** 元のエラー */
  readonly cause?: unknown;
}

/** {@link HttpError} の初期化パラメーター */
export interface HttpErrorInit<TBody> extends Omit<FetcherErrorInit, 'cause'> {
  /** エラーになったレスポンス(ボディは読み取り済み) */
  readonly response: Response;
  /** 解析済みのエラーボディ */
  readonly body: TBody;
}

/** {@link TimeoutError} の初期化パラメーター */
export interface TimeoutErrorInit extends FetcherErrorInit {
  /** 適用していたタイムアウト(ミリ秒) */
  readonly timeout: number;
}

/** {@link ParseError} の初期化パラメーター */
export interface ParseErrorInit extends FetcherErrorInit {
  /** 解析に失敗したレスポンスのステータスコード */
  readonly status: number;
}

/**
 * メッセージ用のリクエスト表記を作る。
 * クエリとフラグメントはトークンなどを含み得るため、メッセージには含めない(`url` プロパティには完全な URL を残す)。
 */
function describeRequest(method: string, url: string): string {
  const end = url.search(/[?#]/);
  return `${method} ${end === -1 ? url : url.slice(0, end)}`;
}

/**
 * fetcher が投げるすべてのエラーの基底クラス。
 *
 * @example
 * ```ts
 * try {
 *   await api.get('/users');
 * } catch (error) {
 *   if (error instanceof HttpError && error.status === 404) { ... }
 *   if (error instanceof FetcherError) console.error(error.method, error.url);
 * }
 * ```
 */
export abstract class FetcherError extends Error {
  /** リクエスト先の URL */
  readonly url: string;
  /** HTTP メソッド(大文字) */
  readonly method: string;

  protected constructor(message: string, init: FetcherErrorInit) {
    // cause を渡さなかった場合に `cause` プロパティ自体を作らないよう、オプションを出し分ける
    super(message, 'cause' in init ? { cause: init.cause } : undefined);
    this.url = init.url;
    this.method = init.method;
  }
}

/**
 * HTTP エラー。`response.ok` が false(ステータスが 200〜299 以外)のときに投げる。
 * @typeParam TBody - エラーボディの型。実行時には検証しないため、既定は unknown
 */
export class HttpError<TBody = unknown> extends FetcherError {
  override readonly name = 'HttpError';
  /** ステータスコード */
  readonly status: number;
  /** ステータステキスト(HTTP/2 以降では空文字のことが多い) */
  readonly statusText: string;
  /**
   * 解析済みのエラーボディ。Content-Type から自動で判定して解析する。
   * JSON が壊れている場合は生のテキスト、空や読み取り失敗の場合は undefined になる。
   */
  readonly body: TBody;
  /** エラーになったレスポンス。ボディは読み取り済みのため、ヘッダーなどの参照に使う */
  readonly response: Response;

  constructor(init: HttpErrorInit<TBody>) {
    const { status, statusText } = init.response;
    const statusLine = statusText === '' ? `${status}` : `${status} ${statusText}`;
    super(`HTTP ${statusLine}: ${describeRequest(init.method, init.url)}`, init);
    this.status = status;
    this.statusText = statusText;
    this.body = init.body;
    this.response = init.response;
  }
}

/** 通信エラー。ネットワーク断・DNS 解決失敗・CORS 拒否などで fetch が失敗したときに投げる */
export class NetworkError extends FetcherError {
  override readonly name = 'NetworkError';

  constructor(init: FetcherErrorInit) {
    super(`Network error: ${describeRequest(init.method, init.url)}`, init);
  }
}

/**
 * タイムアウト。fetcher の `timeout` を超えたときに投げる。
 * 名前はネイティブ(`AbortSignal.timeout()`)と同じ `'TimeoutError'`。
 */
export class TimeoutError extends FetcherError {
  override readonly name = 'TimeoutError';
  /** 適用していたタイムアウト(ミリ秒) */
  readonly timeout: number;

  constructor(init: TimeoutErrorInit) {
    super(`Request timed out after ${init.timeout}ms: ${describeRequest(init.method, init.url)}`, init);
    this.timeout = init.timeout;
  }
}

/**
 * 呼び出し側によるキャンセル。`signal` が中断されたときに投げる。
 * ネイティブの fetch と同じく `error.name === 'AbortError'` でも判定できる。
 * `cause` には signal の中断理由(`signal.reason`)を保持する。
 */
export class AbortError extends FetcherError {
  override readonly name = 'AbortError';

  constructor(init: FetcherErrorInit) {
    super(`Request was aborted: ${describeRequest(init.method, init.url)}`, init);
  }
}

/** レスポンスボディの解析失敗。不正な JSON を受け取ったときに投げる */
export class ParseError extends FetcherError {
  override readonly name = 'ParseError';
  /** 解析に失敗したレスポンスのステータスコード */
  readonly status: number;

  constructor(init: ParseErrorInit) {
    super(
      `Failed to parse response body (HTTP ${init.status}): ${describeRequest(init.method, init.url)}`,
      init,
    );
    this.status = init.status;
  }
}
