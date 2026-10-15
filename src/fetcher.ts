/**
 * HTTP クライアントのインスタンスを組み立てる。
 */
import { DEFAULT_CONFIG } from './defaults.js';
import { sendRequest } from './request.js';
import { validateTimeout } from './timeout.js';
import type {
  Fetcher,
  FetcherConfig,
  FetcherInput,
  FetcherOptions,
  FetcherResponse,
  RawResponseOptions,
  RequestFunction,
  RequestOptions,
  ResolvedFetcherConfig,
} from './types.js';

/** 設定に既定値を適用し、検証する */
function resolveConfig(config: FetcherConfig): ResolvedFetcherConfig {
  return {
    timeout: validateTimeout(config.timeout ?? DEFAULT_CONFIG.timeout),
  };
}

/**
 * HTTP クライアントを作成する。
 *
 * @param config - クライアント全体の設定。省略した項目には既定値を使う
 * @returns リクエスト関数。`get`・`post`・`put`・`patch`・`delete`・`withResponse` を持つ
 * @throws {RangeError} `timeout` が正の有限数でも false でもない場合
 *
 * @example
 * ```ts
 * const api = createFetcher({ timeout: 5_000 });
 *
 * const users = await api.get<User[]>('https://api.example.com/users');
 * await api.patch('https://api.example.com/users/1', { body: { name: 'Bob' }, timeout: false });
 * ```
 */
export function createFetcher(config: FetcherConfig = {}): Fetcher {
  const resolvedConfig = resolveConfig(config);

  const run = async (input: FetcherInput, options: RequestOptions): Promise<unknown> => {
    const { response, data } = await sendRequest(input, options, resolvedConfig);
    return options.responseType === 'response' ? response : data;
  };

  function fetcher(input: FetcherInput, options: RawResponseOptions): Promise<Response>;
  function fetcher<T = unknown>(input: FetcherInput, options?: FetcherOptions): Promise<T>;
  function fetcher(input: FetcherInput, options: RequestOptions = {}): Promise<unknown> {
    return run(input, options);
  }

  /** メソッドを固定したリクエスト関数を作る */
  const withMethod = (method: string): RequestFunction<'method'> => {
    function request(input: FetcherInput, options: Omit<RawResponseOptions, 'method'>): Promise<Response>;
    function request<T = unknown>(input: FetcherInput, options?: Omit<FetcherOptions, 'method'>): Promise<T>;
    function request(input: FetcherInput, options: Omit<RequestOptions, 'method'> = {}): Promise<unknown> {
      return run(input, { ...options, method });
    }
    return request;
  };

  const withResponse = async <T = unknown>(
    input: FetcherInput,
    options: FetcherOptions = {},
  ): Promise<FetcherResponse<T>> => {
    const { response, data } = await sendRequest(input, options, resolvedConfig);
    // 型引数 T は呼び出し側の宣言であり、実行時には検証しない(P4 でスキーマ検証を追加予定)
    return { data: data as T, response };
  };

  return Object.assign(fetcher, {
    get: withMethod('GET'),
    post: withMethod('POST'),
    put: withMethod('PUT'),
    patch: withMethod('PATCH'),
    delete: withMethod('DELETE'),
    withResponse,
  });
}
