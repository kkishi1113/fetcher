import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { createFetcher, HttpError, NetworkError, ParseError } from '../src/index.js';
import { detectResponseType } from '../src/response.js';
import { url } from './support/helpers.js';
import { server } from './support/server.js';

const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

/** 読み取り中に失敗するストリーム(接続が途中で切れた状況の再現) */
function brokenStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encode('{"partial":'));
      controller.error(new TypeError('connection reset'));
    },
  });
}

/** 指定したボディとヘッダーを返すハンドラーを登録する */
function respond(path: string, body: BodyInit | null, init: ResponseInit = {}): void {
  server.use(http.all(url(path), () => new HttpResponse(body, init)));
}

describe('detectResponseType', () => {
  it.each([
    ['application/json', 'json'],
    ['application/json; charset=utf-8', 'json'],
    ['Application/JSON', 'json'],
    ['application/problem+json', 'json'],
    ['application/vnd.api+json', 'json'],
    ['text/plain', 'text'],
    ['text/html; charset=utf-8', 'text'],
    ['text/csv', 'text'],
    ['application/xml', 'text'],
    ['image/svg+xml', 'text'],
    ['application/octet-stream', 'blob'],
    ['image/png', 'blob'],
    ['application/pdf', 'blob'],
    ['', 'text'],
    [null, 'text'],
  ] as const)('%s → %s', (contentType, expected) => {
    expect(detectResponseType(contentType)).toBe(expected);
  });
});

describe('レスポンスの解析', () => {
  const api = createFetcher();

  describe('Content-Type による自動判定', () => {
    it('JSON を解析して返す', async () => {
      server.use(http.get(url('/users/1'), () => HttpResponse.json({ id: 1, name: 'Alice' })));
      await expect(api.get(url('/users/1'))).resolves.toEqual({ id: 1, name: 'Alice' });
    });

    it('+json の Content-Type も JSON として解析する', async () => {
      respond('/problem', '{"title":"x"}', { headers: { 'content-type': 'application/problem+json' } });
      await expect(api.get(url('/problem'))).resolves.toEqual({ title: 'x' });
    });

    it('text/* は文字列で返す', async () => {
      server.use(http.get(url('/text'), () => HttpResponse.text('hello')));
      await expect(api.get(url('/text'))).resolves.toBe('hello');
    });

    it('XML は文字列で返す', async () => {
      server.use(http.get(url('/xml'), () => HttpResponse.xml('<a/>')));
      await expect(api.get(url('/xml'))).resolves.toBe('<a/>');
    });

    it('バイナリは Blob で返す', async () => {
      respond('/bin', encode('abc'), { headers: { 'content-type': 'application/octet-stream' } });
      const data = await api.get(url('/bin'));
      expect(data).toBeInstanceOf(Blob);
      expect(await (data as Blob).text()).toBe('abc');
    });

    it('Content-Type がなければ文字列で返す', async () => {
      respond('/unknown', encode('plain'));
      await expect(api.get(url('/unknown'))).resolves.toBe('plain');
    });

    it('JSON の null・0・false は undefined にせずそのまま返す', async () => {
      server.use(
        http.get(url('/null'), () => HttpResponse.json(null)),
        http.get(url('/zero'), () => HttpResponse.json(0)),
        http.get(url('/false'), () => HttpResponse.json(false)),
      );
      await expect(api.get(url('/null'))).resolves.toBeNull();
      await expect(api.get(url('/zero'))).resolves.toBe(0);
      await expect(api.get(url('/false'))).resolves.toBe(false);
    });
  });

  describe('responseType による明示指定', () => {
    it('text を指定すると JSON でも文字列で返す', async () => {
      server.use(http.get(url('/json'), () => HttpResponse.json({ a: 1 })));
      await expect(api.get(url('/json'), { responseType: 'text' })).resolves.toBe('{"a":1}');
    });

    it('json を指定すると text/plain でも JSON として解析する', async () => {
      server.use(http.get(url('/json-as-text'), () => HttpResponse.text('{"a":1}')));
      await expect(api.get(url('/json-as-text'), { responseType: 'json' })).resolves.toEqual({ a: 1 });
    });

    it('blob と arrayBuffer を指定できる', async () => {
      server.use(http.get(url('/data'), () => HttpResponse.json({ a: 1 })));

      const blob = await api.get(url('/data'), { responseType: 'blob' });
      const buffer = await api.get(url('/data'), { responseType: 'arrayBuffer' });

      expect(blob).toBeInstanceOf(Blob);
      expect(buffer).toBeInstanceOf(ArrayBuffer);
      expect(new TextDecoder().decode(buffer as ArrayBuffer)).toBe('{"a":1}');
    });
  });

  describe('空ボディ', () => {
    it.each([204, 205])('%i は undefined を返す', async (status) => {
      respond(`/status-${status}`, null, { status });
      await expect(api.post(url(`/status-${status}`))).resolves.toBeUndefined();
    });

    it('HEAD は Content-Type が JSON でも undefined を返す', async () => {
      server.use(
        http.head(url('/users'), () =>
          new HttpResponse(null, { headers: { 'content-type': 'application/json', 'content-length': '10' } }),
        ),
      );
      await expect(api(url('/users'), { method: 'HEAD' })).resolves.toBeUndefined();
    });

    it('HEAD はモックや Service Worker がボディを付けて返しても undefined を返す', async () => {
      respond('/users', '{"a":1}', { headers: { 'content-type': 'application/json' } });
      await expect(api(url('/users'), { method: 'HEAD' })).resolves.toBeUndefined();
    });

    it('200 でもボディがなければ undefined を返す', async () => {
      respond('/no-body', null, { status: 200 });
      await expect(api.get(url('/no-body'))).resolves.toBeUndefined();
    });

    it('JSON の空ボディと空白だけのボディは undefined を返す', async () => {
      respond('/empty-json', '', { headers: { 'content-type': 'application/json' } });
      respond('/blank-json', ' \n', { headers: { 'content-type': 'application/json' } });
      await expect(api.get(url('/empty-json'))).resolves.toBeUndefined();
      await expect(api.get(url('/blank-json'))).resolves.toBeUndefined();
    });

    it.each(['text', 'blob', 'arrayBuffer'] as const)('長さ 0 のボディは %s でも undefined を返す', async (responseType) => {
      respond('/empty', '', { headers: { 'content-type': 'text/plain' } });
      await expect(api.get(url('/empty'), { responseType })).resolves.toBeUndefined();
    });
  });

  describe('解析の失敗', () => {
    it('不正な JSON は ParseError にし、元の SyntaxError を cause に保持する', async () => {
      respond('/broken', '{"a":', { headers: { 'content-type': 'application/json' } });

      const error = await api.get(url('/broken')).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ParseError);
      expect(error).toMatchObject({ name: 'ParseError', status: 200, method: 'GET', url: url('/broken') });
      expect((error as ParseError).cause).toBeInstanceOf(SyntaxError);
    });

    it('ボディの読み取り中に接続が切れたら、ParseError ではなく NetworkError にする', async () => {
      respond('/broken-stream', brokenStream(), { headers: { 'content-type': 'application/json' } });
      const error = await api.get(url('/broken-stream')).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NetworkError);
      expect((error as NetworkError).cause).toBeInstanceOf(TypeError);
    });

    it('json を明示指定して HTML が返ると ParseError にする', async () => {
      server.use(http.get(url('/html'), () => HttpResponse.html('<html></html>')));
      await expect(api.get(url('/html'), { responseType: 'json' })).rejects.toBeInstanceOf(ParseError);
    });
  });

  describe('HTTP エラーのボディ', () => {
    /** HttpError を取り出す */
    async function httpError(path: string, options: { responseType?: 'text' } = {}): Promise<HttpError> {
      const error = await api.get(url(path), options).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpError);
      return error as HttpError;
    }

    it('JSON のエラーボディを解析する', async () => {
      server.use(http.get(url('/e'), () => HttpResponse.json({ code: 'invalid' }, { status: 400 })));
      expect((await httpError('/e')).body).toEqual({ code: 'invalid' });
    });

    it('テキストのエラーボディは文字列にする', async () => {
      server.use(http.get(url('/e'), () => HttpResponse.text('Bad Gateway', { status: 502 })));
      expect((await httpError('/e')).body).toBe('Bad Gateway');
    });

    it('壊れた JSON のエラーボディは ParseError にせず、生のテキストを入れる', async () => {
      respond('/e', '<html>proxy error</html>', { status: 500, headers: { 'content-type': 'application/json' } });
      expect((await httpError('/e')).body).toBe('<html>proxy error</html>');
    });

    it('空のエラーボディは undefined にする', async () => {
      respond('/e', null, { status: 404 });
      expect((await httpError('/e')).body).toBeUndefined();
    });

    it.each(['', ' \n'])('Content-Type が JSON でも中身が空(%j)なら undefined にする', async (body) => {
      respond('/e', body, { status: 500, headers: { 'content-type': 'application/json' } });
      expect((await httpError('/e')).body).toBeUndefined();
    });

    it('エラーボディの読み取り中に接続が切れても、body を undefined にして HttpError を投げる', async () => {
      respond('/e', brokenStream(), { status: 503, headers: { 'content-type': 'application/json' } });
      const error = await httpError('/e');

      expect(error.status).toBe(503);
      expect(error.body).toBeUndefined();
    });

    it('responseType の指定にかかわらず、エラーボディは Content-Type で判定する', async () => {
      server.use(http.get(url('/e'), () => HttpResponse.json({ code: 'not_found' }, { status: 404 })));
      expect((await httpError('/e', { responseType: 'text' })).body).toEqual({ code: 'not_found' });
    });
  });
});
