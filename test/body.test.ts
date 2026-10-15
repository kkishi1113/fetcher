import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { JSON_CONTENT_TYPE, serializeBody } from '../src/body.js';
import { createFetcher, FetcherError, type FetcherBody } from '../src/index.js';
import { url } from './support/helpers.js';
import { server } from './support/server.js';

/** サーバーが受け取ったリクエストを記録する */
interface Received {
  method?: string;
  contentType?: string | null;
  text?: string;
}

function receive(path: string): Received {
  const received: Received = {};
  server.use(
    http.all(url(path), async ({ request }) => {
      received.method = request.method;
      received.contentType = request.headers.get('content-type');
      received.text = await request.text();
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return received;
}

describe('serializeBody', () => {
  it('プレーンオブジェクトを JSON 化し、application/json を返す', () => {
    expect(serializeBody({ name: 'Alice', tags: ['a'] })).toEqual({
      body: '{"name":"Alice","tags":["a"]}',
      contentType: JSON_CONTENT_TYPE,
    });
  });

  it('配列・空オブジェクト・プロトタイプが null のオブジェクトも JSON 化する', () => {
    const nullPrototype: Record<string, unknown> = Object.create(null);
    nullPrototype['a'] = 1;

    expect(serializeBody([1, 2])).toEqual({ body: '[1,2]', contentType: JSON_CONTENT_TYPE });
    expect(serializeBody([])).toEqual({ body: '[]', contentType: JSON_CONTENT_TYPE });
    expect(serializeBody({})).toEqual({ body: '{}', contentType: JSON_CONTENT_TYPE });
    expect(serializeBody(nullPrototype)).toEqual({ body: '{"a":1}', contentType: JSON_CONTENT_TYPE });
  });

  it.each<readonly [string, FetcherBody]>([
    ['string', 'raw text'],
    ['FormData', new FormData()],
    ['Blob', new Blob(['x'])],
    ['URLSearchParams', new URLSearchParams({ a: '1' })],
    ['ArrayBuffer', new ArrayBuffer(1)],
    ['Uint8Array', new Uint8Array([1])],
    ['DataView', new DataView(new ArrayBuffer(1))],
    ['ReadableStream', new ReadableStream()],
  ])('%s はそのまま渡し、Content-Type を付けない', (_name, body) => {
    const serialized = serializeBody(body);
    expect(serialized.body).toBe(body);
    expect(serialized.contentType).toBeUndefined();
  });

  it('null と undefined はボディなしにする', () => {
    expect(serializeBody(null)).toEqual({ body: undefined, contentType: undefined });
    expect(serializeBody(undefined)).toEqual({ body: undefined, contentType: undefined });
  });

  it.each<readonly [string, unknown]>([
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1])],
    ['Date', new Date(0)],
    ['クラスインスタンス', new (class User {})()],
    ['Promise', Promise.resolve({})],
    ['number', 42],
  ])('%s は黙ってデータが欠落しないよう TypeError にする', (_name, body) => {
    expect(() => serializeBody(body as FetcherBody)).toThrow(TypeError);
  });

  it('JSON 化できない値(循環参照)は TypeError にする', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => serializeBody(circular)).toThrow(TypeError);
  });
});

describe('リクエストボディの送信', () => {
  const api = createFetcher();

  it('オブジェクトを JSON として送り、Content-Type: application/json を付ける', async () => {
    const received = receive('/users');
    await api.post(url('/users'), { body: { name: 'Alice' } });

    expect(received.contentType).toBe('application/json');
    expect(received.text).toBe('{"name":"Alice"}');
  });

  it('利用者が指定した Content-Type を優先する(大文字小文字を区別しない)', async () => {
    const received = receive('/users/1');
    await api.patch(url('/users/1'), {
      body: { name: 'Bob' },
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });

    expect(received.contentType).toBe('application/merge-patch+json');
    expect(received.text).toBe('{"name":"Bob"}');
  });

  it('Headers インスタンスや配列形式のヘッダーにも Content-Type を追加できる', async () => {
    const first = receive('/a');
    await api.post(url('/a'), { body: [1], headers: new Headers({ 'X-Trace': '1' }) });
    const second = receive('/b');
    await api.post(url('/b'), { body: [2], headers: [['X-Trace', '2']] });

    expect(first.contentType).toBe('application/json');
    expect(second.contentType).toBe('application/json');
  });

  it('FormData には Content-Type を付けず、fetch が boundary 付きで設定する', async () => {
    const received = receive('/upload');
    const form = new FormData();
    form.append('name', 'Alice');
    await api.post(url('/upload'), { body: form });

    expect(received.contentType).toMatch(/^multipart\/form-data; boundary=.+/);
    expect(received.text).toContain('Alice');
  });

  it('URLSearchParams・Blob・string の Content-Type は fetch に任せる', async () => {
    const form = receive('/form');
    await api.post(url('/form'), { body: new URLSearchParams({ q: 'a b' }) });
    const blob = receive('/blob');
    await api.post(url('/blob'), { body: new Blob(['a,b'], { type: 'text/csv' }) });
    const text = receive('/text');
    await api.post(url('/text'), { body: 'hello' });

    expect(form.contentType).toBe('application/x-www-form-urlencoded;charset=UTF-8');
    expect(form.text).toBe('q=a+b');
    expect(blob.contentType).toBe('text/csv');
    expect(text.contentType).toBe('text/plain;charset=UTF-8');
  });

  it('ArrayBuffer と TypedArray には Content-Type を付けない', async () => {
    const buffer = receive('/buffer');
    await api.put(url('/buffer'), { body: new TextEncoder().encode('bin').buffer });
    const view = receive('/view');
    await api.put(url('/view'), { body: new TextEncoder().encode('bin') });

    expect(buffer.contentType).toBeNull();
    expect(buffer.text).toBe('bin');
    expect(view.contentType).toBeNull();
    expect(view.text).toBe('bin');
  });

  it('ReadableStream は duplex を指定しなくても送れる', async () => {
    const received = receive('/stream');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed'));
        controller.close();
      },
    });
    await api.post(url('/stream'), { body: stream });

    expect(received.text).toBe('streamed');
  });

  it('DELETE にもボディを付けられる', async () => {
    const received = receive('/items');
    await api.delete(url('/items'), { body: { ids: [1, 2] } });

    expect(received.method).toBe('DELETE');
    expect(received.text).toBe('{"ids":[1,2]}');
  });

  it('GET にボディを付けると FetcherError ではなく TypeError で reject する', async () => {
    const error = await api(url('/users'), { method: 'GET', body: { a: 1 } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(FetcherError);
  });

  it('未対応のボディ型は送信前に TypeError で reject する', async () => {
    const error = await api.post(url('/users'), { body: new Map() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(FetcherError);
  });
});
