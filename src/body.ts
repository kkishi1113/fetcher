/**
 * リクエストボディの変換。
 *
 * - プレーンオブジェクトと配列: JSON 文字列にし、付与すべき Content-Type として application/json を返す
 * - BodyInit: そのまま返し、Content-Type は fetch に任せる
 *   (FormData に手動で Content-Type を付けると multipart の boundary が欠けるため)
 */
import type { FetcherBody } from './types.js';

/** JSON ボディに付ける Content-Type */
export const JSON_CONTENT_TYPE = 'application/json';

/** 変換後のリクエストボディ */
export interface SerializedBody {
  /** fetch に渡すボディ */
  readonly body: BodyInit | undefined;
  /** 付与すべき Content-Type。fetch に任せる場合は undefined */
  readonly contentType: string | undefined;
}

/** fetch がそのまま受け付けるボディか */
function isBodyInit(value: unknown): value is BodyInit {
  return (
    typeof value === 'string' ||
    value instanceof FormData ||
    value instanceof Blob ||
    value instanceof URLSearchParams ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof ReadableStream
  );
}

/** プロトタイプが Object.prototype または null のオブジェクトか */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * リクエストボディを fetch に渡せる形に変換する。
 * @throws {TypeError} プレーンオブジェクト・配列・BodyInit のいずれでもない場合、
 *   または JSON 化に失敗した場合(循環参照・BigInt など)
 */
export function serializeBody(body: FetcherBody | null | undefined): SerializedBody {
  if (body === undefined || body === null) {
    return { body: undefined, contentType: undefined };
  }
  if (isBodyInit(body)) {
    return { body, contentType: undefined };
  }
  if (Array.isArray(body) || isPlainObject(body)) {
    return { body: JSON.stringify(body), contentType: JSON_CONTENT_TYPE };
  }
  throw new TypeError(
    `Unsupported request body: ${Object.prototype.toString.call(body)}. ` +
      'Use a plain object, an array, or a BodyInit value.',
  );
}
