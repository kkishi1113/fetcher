/**
 * レスポンスボディの解析。
 *
 * - Content-Type から json / text / blob を自動で選ぶ(明示指定も可)
 * - 204・205・HEAD・空ボディは例外にせず undefined を返す
 */
import { ParseError } from './errors.js';
import { raceSignal } from './timeout.js';
import type { ParsedResponseType } from './types.js';

/** ボディを持たないステータス(204 No Content / 205 Reset Content) */
const NO_BODY_STATUSES: readonly number[] = [204, 205];

/** ボディの読み取りに必要な情報 */
export interface ReadContext {
  /** リクエスト先の URL(エラー用) */
  readonly url: string;
  /** HTTP メソッド(大文字) */
  readonly method: string;
  /** 読み取りを中断するためのシグナル */
  readonly signal: AbortSignal | undefined;
}

/**
 * Content-Type から解析方法を決める。
 * - `application/json`・`*+json` → json
 * - `text/*`・`application/xml`・`*+xml` → text
 * - Content-Type なし → text(バイナリなら blob を明示指定する)
 * - それ以外 → blob
 */
export function detectResponseType(contentType: string | null): ParsedResponseType {
  const mimeType = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (mimeType === '') return 'text';
  if (mimeType === 'application/json' || mimeType.endsWith('+json')) return 'json';
  if (mimeType.startsWith('text/') || mimeType === 'application/xml' || mimeType.endsWith('+xml')) {
    return 'text';
  }
  return 'blob';
}

/** ボディを読まずに空と判断できるか */
function hasNoBody(response: Response, method: string): boolean {
  return method === 'HEAD' || NO_BODY_STATUSES.includes(response.status) || response.body === null;
}

/** JSON として空(空白のみを含む)か。JSON の文法上、前後の空白は値に含まれない */
function isBlank(text: string): boolean {
  return text.trim() === '';
}

/** JSON 以外の形式で読み取る。長さ 0 なら undefined を返す */
async function readAs(
  response: Response,
  type: Exclude<ParsedResponseType, 'json'>,
  signal: AbortSignal | undefined,
): Promise<string | Blob | ArrayBuffer | undefined> {
  switch (type) {
    case 'text': {
      const text = await raceSignal(response.text(), signal);
      return text === '' ? undefined : text;
    }
    case 'blob': {
      const blob = await raceSignal(response.blob(), signal);
      return blob.size === 0 ? undefined : blob;
    }
    case 'arrayBuffer': {
      const buffer = await raceSignal(response.arrayBuffer(), signal);
      return buffer.byteLength === 0 ? undefined : buffer;
    }
  }
}

/**
 * 成功レスポンスのボディを解析する。
 *
 * 読み取り中の通信エラーや中断は、元のエラーのまま投げる(呼び出し側で分類する)。
 * @param responseType - 解析方法。省略時は Content-Type から自動で判定する
 * @throws {ParseError} JSON の解析に失敗した場合
 */
export async function parseResponseBody(
  response: Response,
  responseType: ParsedResponseType | undefined,
  context: ReadContext,
): Promise<unknown> {
  if (hasNoBody(response, context.method)) return undefined;

  const type = responseType ?? detectResponseType(response.headers.get('content-type'));
  if (type !== 'json') return readAs(response, type, context.signal);

  const text = await raceSignal(response.text(), context.signal);
  if (isBlank(text)) return undefined;
  try {
    const data: unknown = JSON.parse(text);
    return data;
  } catch (error) {
    throw new ParseError({
      url: context.url,
      method: context.method,
      status: response.status,
      cause: error,
    });
  }
}

/**
 * HTTP エラーレスポンスのボディを読み取る。
 *
 * エラーボディは `responseType` の指定にかかわらず Content-Type で判定する
 * (ファイルのダウンロード API が JSON でエラーを返す場合などに対応するため)。
 * HttpError を優先するため、JSON が壊れていれば例外にせず生のテキストを返す。
 * 読み取り中の通信エラーや中断は、元のエラーのまま投げる。
 */
export async function readErrorBody(response: Response, context: ReadContext): Promise<unknown> {
  if (hasNoBody(response, context.method)) return undefined;

  const type = detectResponseType(response.headers.get('content-type'));
  if (type !== 'json') return readAs(response, type, context.signal);

  const text = await raceSignal(response.text(), context.signal);
  if (isBlank(text)) return undefined;
  try {
    const data: unknown = JSON.parse(text);
    return data;
  } catch {
    return text;
  }
}
