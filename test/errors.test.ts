import { describe, expect, it } from 'vitest';
import {
  AbortError,
  FetcherError,
  HttpError,
  NetworkError,
  ParseError,
  TimeoutError,
} from '../src/index.js';

const URL_WITH_SECRET = 'https://api.example.test/users?token=secret#section';
const context = { url: URL_WITH_SECRET, method: 'GET' };

describe('エラークラス', () => {
  const cause = new TypeError('Failed to fetch');
  const cases: ReadonlyArray<readonly [string, FetcherError]> = [
    ['HttpError', new HttpError({ ...context, response: new Response(null, { status: 500 }), body: undefined })],
    ['NetworkError', new NetworkError({ ...context, cause })],
    ['TimeoutError', new TimeoutError({ ...context, timeout: 1_000, cause })],
    ['AbortError', new AbortError({ ...context, cause })],
    ['ParseError', new ParseError({ ...context, status: 200, cause })],
  ];

  it.each(cases)('%s は FetcherError と Error を継承し、name と url・method を持つ', (name, error) => {
    expect(error).toBeInstanceOf(FetcherError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.url).toBe(URL_WITH_SECRET);
    expect(error.method).toBe('GET');
    expect(error.stack?.startsWith(`${name}:`)).toBe(true);
  });

  it.each(cases)('%s のメッセージにはクエリとフラグメントを含めない', (_name, error) => {
    expect(error.message).toContain('GET https://api.example.test/users');
    expect(error.message).not.toContain('secret');
    expect(error.message).not.toContain('section');
  });

  it('キャンセルはネイティブと同じく name === "AbortError" で判定できる', () => {
    const error: unknown = new AbortError({ ...context, cause: new DOMException('aborted', 'AbortError') });
    expect(error instanceof Error && error.name === 'AbortError').toBe(true);
  });

  it('元のエラーを cause に保持する', () => {
    const reason = new Error('user cancelled');
    expect(new AbortError({ ...context, cause: reason }).cause).toBe(reason);
    expect(new NetworkError({ ...context, cause }).cause).toBe(cause);
  });

  it('HttpError はステータス・ボディ・レスポンスを保持し、cause を持たない', () => {
    const response = new Response(null, { status: 404, statusText: 'Not Found' });
    const body = { message: 'not found' };
    const error = new HttpError({ ...context, response, body });

    expect(error).toMatchObject({ status: 404, statusText: 'Not Found', body, response });
    expect(error.message).toBe('HTTP 404 Not Found: GET https://api.example.test/users');
    expect('cause' in error).toBe(false);
  });

  it('HttpError は statusText が空でもメッセージが崩れない(HTTP/2 など)', () => {
    const error = new HttpError({ ...context, response: new Response(null, { status: 503 }), body: undefined });
    expect(error.message).toBe('HTTP 503: GET https://api.example.test/users');
  });

  it('TimeoutError はタイムアウト値を、ParseError はステータスを保持する', () => {
    expect(new TimeoutError({ ...context, timeout: 1_500, cause }).timeout).toBe(1_500);
    expect(new ParseError({ ...context, status: 201, cause }).status).toBe(201);
  });
});
