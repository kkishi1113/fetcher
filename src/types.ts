/**
 * 公開型の定義。このファイルは実行時のコードを持たない。
 */

/** リクエスト先。文字列または URL オブジェクト */
export type FetcherInput = string | URL;

/**
 * タイムアウトの指定。
 * - 数値: タイムアウトまでのミリ秒(正の有限数)
 * - `false`: タイムアウトを無効にする
 */
export type TimeoutOption = number | false;

/**
 * JSON に変換して送信するボディ。
 *
 * 実行時に JSON 化するのは、プレーンオブジェクト(プロトタイプが `Object.prototype` または `null`)と
 * 配列だけ。Map・Set・Date・クラスインスタンスなどは、データが黙って欠落するのを防ぐため TypeError にする。
 * interface で宣言した DTO もそのまま渡せるように、型は `object` としている
 * (`Record<string, unknown>` だと interface を受け付けないため)。
 */
export type JsonBody = object;

/**
 * リクエストボディ。
 * - プレーンオブジェクト・配列: JSON 文字列にし、`Content-Type: application/json` を付ける
 * - `BodyInit`(string・FormData・Blob・URLSearchParams・ArrayBuffer・TypedArray・ReadableStream): そのまま fetch に渡す
 */
export type FetcherBody = BodyInit | JsonBody;

/**
 * レスポンスボディの解析方法。
 * - `'json'`: JSON として解析する
 * - `'text'`: 文字列として返す
 * - `'blob'`: Blob として返す
 * - `'arrayBuffer'`: ArrayBuffer として返す
 */
export type ParsedResponseType = 'json' | 'text' | 'blob' | 'arrayBuffer';

/** `responseType` に指定できる値。`'response'` はボディを読まずに Response をそのまま返す */
export type FetcherResponseType = ParsedResponseType | 'response';

/**
 * リクエストオプションの共通部分。
 *
 * `RequestInit` を拡張しており、`headers`・`credentials`・`cache`・`mode` などの標準オプションは
 * そのまま fetch に渡す。`method` は大文字に正規化する(fetch は `patch` などを正規化しないため)。
 */
export interface BaseRequestOptions extends Omit<RequestInit, 'body' | 'signal'> {
  /**
   * リクエストボディ。プレーンオブジェクトと配列は JSON 化し、
   * Content-Type が未指定なら `application/json` を付ける。
   */
  body?: FetcherBody | null;
  /**
   * 呼び出し側によるキャンセル用のシグナル。中断すると {@link AbortError} で reject される。
   * タイムアウト用のシグナルとは `AbortSignal.any()` で合成する。
   */
  signal?: AbortSignal | null;
  /**
   * タイムアウト(ミリ秒)。`false` で無効。省略時は `createFetcher` の設定値を使う。
   * レスポンスボディの読み取り完了までが対象。
   */
  timeout?: TimeoutOption;
  /**
   * リクエストボディのストリーミング方式。
   * ボディが ReadableStream で、この値が省略されている場合は `'half'` を自動で設定する。
   */
  duplex?: 'half';
}

/** 解析済みのデータを返すリクエストのオプション */
export interface FetcherOptions extends BaseRequestOptions {
  /**
   * レスポンスボディの解析方法。省略時は Content-Type から自動で判定する
   * (JSON 系は json、`text/*` と XML 系は text、Content-Type なしは text、それ以外は blob)。
   * HTTP エラー時のボディは、この指定にかかわらず自動判定で解析する。
   */
  responseType?: ParsedResponseType;
}

/** 未解析の Response を返すリクエストのオプション */
export interface RawResponseOptions extends BaseRequestOptions {
  /**
   * `'response'` を指定すると、ボディを読まずに Response をそのまま返す。
   * HTTP エラーは通常どおり {@link HttpError} として投げる。
   * タイムアウトはボディの読み取りにも及ぶため、大きなストリームを読む場合は `timeout` を調整すること。
   */
  responseType: 'response';
}

/** 内部処理用のオプション。`responseType` のすべての値を受け付ける */
export interface RequestOptions extends BaseRequestOptions {
  responseType?: FetcherResponseType;
}

/** `createFetcher` の設定 */
export interface FetcherConfig {
  /**
   * 既定のタイムアウト(ミリ秒)。`false` で無効。リクエスト単位の `timeout` で上書きできる。
   * @defaultValue 10000
   */
  timeout?: TimeoutOption;
}

/** 既定値を適用済みの設定 */
export type ResolvedFetcherConfig = Readonly<Required<FetcherConfig>>;

/** {@link Fetcher.withResponse} の戻り値 */
export interface FetcherResponse<T> {
  /** 解析済みのデータ */
  readonly data: T;
  /** レスポンス。ボディは読み取り済みのため、ステータスやヘッダーの参照に使う */
  readonly response: Response;
}

/**
 * リクエスト関数。
 *
 * - `responseType: 'response'` を指定した場合は、未解析の Response を返す
 * - それ以外は、解析済みのデータを返す。空ボディ(204・205・HEAD・長さ0)の場合は `undefined` になる
 *
 * @typeParam K - オプションから除外するキー。メソッド別の関数で `method` などを除くために使う
 */
export interface RequestFunction<K extends keyof BaseRequestOptions = never> {
  /**
   * リクエストを送り、未解析の Response を返す。
   * @param input - リクエスト先
   * @param options - `responseType: 'response'` を含むオプション
   * @throws {@link HttpError} `response.ok` が false のとき
   * @throws {@link NetworkError} | {@link TimeoutError} | {@link AbortError}
   */
  (input: FetcherInput, options: Omit<RawResponseOptions, K>): Promise<Response>;
  /**
   * リクエストを送り、解析済みのデータを返す。
   * @typeParam T - 解析後のデータの型(実行時には検証しない)
   * @param input - リクエスト先
   * @param options - リクエストオプション
   * @throws {@link HttpError} `response.ok` が false のとき
   * @throws {@link NetworkError} | {@link TimeoutError} | {@link AbortError} | {@link ParseError}
   */
  <T = unknown>(input: FetcherInput, options?: Omit<FetcherOptions, K>): Promise<T>;
}

/**
 * `createFetcher` が返す HTTP クライアント。
 *
 * 関数として呼ぶと任意のメソッドでリクエストを送る。`get` などはメソッドを固定した短縮形。
 *
 * @example
 * ```ts
 * const api = createFetcher();
 * const user = await api.get<User>('https://api.example.com/users/1');
 * await api.post('https://api.example.com/users', { body: { name: 'Alice' } });
 * const { data, response } = await api.withResponse<User[]>('https://api.example.com/users');
 * const res = await api.get('https://api.example.com/file', { responseType: 'response' });
 * ```
 *
 * 引数や設定の誤り(GET にボディを付けた、URL が不正、未対応のボディ型、不正な timeout など)は
 * FetcherError ではなく、ネイティブの TypeError・RangeError で reject される。
 */
export interface Fetcher extends RequestFunction {
  /** GET リクエストを送る。ボディは指定できない */
  readonly get: RequestFunction<'method' | 'body'>;
  /** POST リクエストを送る */
  readonly post: RequestFunction<'method'>;
  /** PUT リクエストを送る */
  readonly put: RequestFunction<'method'>;
  /** PATCH リクエストを送る */
  readonly patch: RequestFunction<'method'>;
  /** DELETE リクエストを送る */
  readonly delete: RequestFunction<'method'>;
  /**
   * リクエストを送り、解析済みのデータと Response の両方を返す。
   * ステータスコードやレスポンスヘッダーが必要な場合に使う。
   * @typeParam T - 解析後のデータの型(実行時には検証しない)
   * @param input - リクエスト先
   * @param options - リクエストオプション
   * @throws {@link HttpError} `response.ok` が false のとき
   * @throws {@link NetworkError} | {@link TimeoutError} | {@link AbortError} | {@link ParseError}
   */
  withResponse<T = unknown>(input: FetcherInput, options?: FetcherOptions): Promise<FetcherResponse<T>>;
}
