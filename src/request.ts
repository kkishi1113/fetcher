/**
 * 1 回のリクエストの実行。
 *
 * Request の組み立て → fetch → HTTP エラーの判定 → ボディの解析までを行い、
 * 失敗をエラークラスに分類する。
 */
import { serializeBody } from './body.js';
import { DEFAULT_METHOD } from './defaults.js';
import {
  AbortError,
  FetcherError,
  HttpError,
  NetworkError,
  TimeoutError,
} from './errors.js';
import { parseResponseBody, readErrorBody, type ReadContext } from './response.js';
import { createRequestSignal, validateTimeout, type RequestSignal } from './timeout.js';
import type { FetcherInput, RequestOptions, ResolvedFetcherConfig } from './types.js';

/** リクエストの結果 */
export interface RequestResult {
  /** レスポンス。`responseType: 'response'` 以外ではボディは読み取り済み */
  readonly response: Response;
  /** 解析済みのデータ。`responseType: 'response'` の場合は undefined */
  readonly data: unknown;
}

/** エラーに載せるリクエストの情報 */
interface RequestContext {
  readonly url: string;
  readonly method: string;
}

/** RequestInit に、lib.dom の型にまだない duplex を加えたもの */
type RequestInitWithDuplex = RequestInit & { duplex?: 'half' };

/**
 * fetch やボディ読み取りの失敗を、中断の原因に応じて分類する。
 * 中断されていなければ通信エラーとみなす。
 */
function toTransportError(
  error: unknown,
  requestSignal: RequestSignal,
  context: RequestContext,
): FetcherError {
  const abortCause = requestSignal.abortCause();
  if (abortCause?.type === 'timeout') {
    return new TimeoutError({ ...context, timeout: abortCause.timeout, cause: error });
  }
  if (abortCause?.type === 'abort') {
    return new AbortError({ ...context, cause: error });
  }
  return new NetworkError({ ...context, cause: error });
}

/**
 * HTTP エラーのレスポンスから HttpError を作る。
 * ボディの読み取り中に中断された場合は、HTTP エラーとして完結していないため中断のエラーを返す。
 */
async function createHttpError(
  response: Response,
  requestSignal: RequestSignal,
  context: ReadContext,
): Promise<FetcherError> {
  let body: unknown;
  try {
    body = await readErrorBody(response, context);
  } catch (error) {
    if (requestSignal.abortCause() !== undefined) {
      return toTransportError(error, requestSignal, context);
    }
    // ボディが読めなくても、ステータスは分かっているので HTTP エラーとして報告する
    body = undefined;
  }
  return new HttpError({ url: context.url, method: context.method, response, body });
}

/**
 * リクエストを 1 回実行する。
 *
 * 引数の誤り(GET にボディ、不正な URL・ヘッダー、未対応のボディ型、不正な timeout)は
 * fetch の前に `new Request()` などで検出し、ネイティブの TypeError・RangeError のまま投げる。
 * こうすることで、通信エラー(NetworkError)と混ざらない。
 */
export async function sendRequest(
  input: FetcherInput,
  options: RequestOptions,
  config: ResolvedFetcherConfig,
): Promise<RequestResult> {
  const {
    body: rawBody,
    headers: rawHeaders,
    method: rawMethod,
    signal: callerSignal,
    timeout: rawTimeout,
    responseType,
    ...init
  } = options;

  // fetch は GET・POST などの 6 メソッドしか大文字に正規化しない(patch はそのまま送られる)
  const method = (rawMethod ?? DEFAULT_METHOD).toUpperCase();
  const headers = new Headers(rawHeaders);
  const { body, contentType } = serializeBody(rawBody);
  if (contentType !== undefined && !headers.has('content-type')) {
    headers.set('content-type', contentType);
  }

  const requestSignal = createRequestSignal(
    callerSignal,
    validateTimeout(rawTimeout ?? config.timeout),
  );
  const requestInit: RequestInitWithDuplex = {
    ...init,
    method,
    headers,
    body,
    signal: requestSignal.signal ?? null,
  };
  // ReadableStream のボディは duplex: 'half' がないと Chrome・Node で TypeError になる
  if (body instanceof ReadableStream && requestInit.duplex === undefined) {
    requestInit.duplex = 'half';
  }
  const request = new Request(input, requestInit);
  const context: RequestContext = { url: request.url, method };

  let response: Response;
  try {
    response = await fetch(request);
  } catch (error) {
    throw toTransportError(error, requestSignal, context);
  }

  const readContext: ReadContext = { ...context, signal: requestSignal.signal };
  if (!response.ok) {
    throw await createHttpError(response, requestSignal, readContext);
  }
  if (responseType === 'response') {
    return { response, data: undefined };
  }

  try {
    const data = await parseResponseBody(response, responseType, readContext);
    return { response, data };
  } catch (error) {
    if (error instanceof FetcherError) throw error;
    throw toTransportError(error, requestSignal, context);
  }
}
