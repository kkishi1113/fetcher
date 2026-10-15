import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { createFetcher, FetcherError, HttpError, NetworkError } from '../src/index.js';
import { url } from './support/helpers.js';
import { server } from './support/server.js';

describe('createFetcher', () => {
  const api = createFetcher();

  describe('成功レスポンス', () => {
    it('解析済みのデータを返す', async () => {
      server.use(http.get(url('/users'), () => HttpResponse.json([{ id: 1 }])));
      await expect(api.get(url('/users'))).resolves.toEqual([{ id: 1 }]);
    });

    it('URL オブジェクトも受け付ける', async () => {
      server.use(http.get(url('/users'), () => HttpResponse.json([])));
      await expect(api.get(new URL(url('/users')))).resolves.toEqual([]);
    });

    it.each([200, 201, 202, 299])('%i は成功として扱う(2xx の境界値)', async (status) => {
      server.use(http.get(url('/status'), () => HttpResponse.json({ status }, { status })));
      await expect(api.get(url('/status'))).resolves.toEqual({ status });
    });
  });

  describe('HTTP エラー', () => {
    it.each([300, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504])(
      '%i は HttpError を投げる',
      async (status) => {
        server.use(http.get(url('/status'), () => new HttpResponse(null, { status })));
        const error = await api.get(url('/status')).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(HttpError);
        expect(error).toBeInstanceOf(FetcherError);
        expect((error as HttpError).status).toBe(status);
      },
    );

    it('ステータス・解析済みのボディ・URL・メソッド・レスポンスを保持する', async () => {
      server.use(
        http.delete(url('/users/1'), () =>
          HttpResponse.json(
            { code: 'forbidden' },
            { status: 403, statusText: 'Forbidden', headers: { 'x-request-id': 'abc' } },
          ),
        ),
      );
      const error = await api.delete(url('/users/1?force=true')).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HttpError);
      const httpError = error as HttpError;
      expect(httpError).toMatchObject({
        name: 'HttpError',
        status: 403,
        statusText: 'Forbidden',
        body: { code: 'forbidden' },
        url: url('/users/1?force=true'),
        method: 'DELETE',
      });
      expect(httpError.message).toBe('HTTP 403 Forbidden: DELETE https://api.example.test/users/1');
      expect(httpError.response.headers.get('x-request-id')).toBe('abc');
    });
  });

  describe('通信エラー', () => {
    it('NetworkError にし、元の TypeError を cause に保持する', async () => {
      server.use(http.get(url('/down'), () => HttpResponse.error()));
      const error = await api.get(url('/down')).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NetworkError);
      expect(error).toMatchObject({ name: 'NetworkError', method: 'GET', url: url('/down') });
      expect((error as NetworkError).cause).toBeInstanceOf(TypeError);
    });
  });

  describe('メソッド', () => {
    /** 受け取ったメソッドを記録するハンドラーを登録する */
    function recordMethods(): string[] {
      const methods: string[] = [];
      server.use(
        http.all(url('/resource'), ({ request }) => {
          methods.push(request.method);
          return new HttpResponse(null, { status: 204 });
        }),
      );
      return methods;
    }

    it('get / post / put / patch / delete はそれぞれのメソッドで送る', async () => {
      const methods = recordMethods();
      await api.get(url('/resource'));
      await api.post(url('/resource'));
      await api.put(url('/resource'));
      await api.patch(url('/resource'));
      await api.delete(url('/resource'));

      expect(methods).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    });

    it('関数として呼ぶと method を省略した場合は GET、小文字は大文字に正規化する', async () => {
      const methods = recordMethods();
      await api(url('/resource'));
      await api(url('/resource'), { method: 'patch' });
      await api(url('/resource'), { method: 'options' });

      expect(methods).toEqual(['GET', 'PATCH', 'OPTIONS']);
    });
  });

  describe('標準オプションの受け渡し', () => {
    it('headers をそのまま送る', async () => {
      let received: string | null = null;
      server.use(
        http.get(url('/users'), ({ request }) => {
          received = request.headers.get('x-custom');
          return HttpResponse.json([]);
        }),
      );
      await api.get(url('/users'), { headers: { 'X-Custom': 'yes' } });

      expect(received).toBe('yes');
    });

    it('cache・credentials・redirect などの RequestInit をそのまま fetch に渡す', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      server.use(http.get(url('/users'), () => HttpResponse.json([])));
      await api.get(url('/users'), { cache: 'no-store', credentials: 'include', redirect: 'error' });

      const request = fetchSpy.mock.calls[0]?.[0];
      expect(request).toBeInstanceOf(Request);
      expect(request).toMatchObject({ cache: 'no-store', credentials: 'include', redirect: 'error' });
    });
  });

  describe('Response の取得', () => {
    it('withResponse は解析済みのデータと Response を返す', async () => {
      server.use(
        http.get(url('/users'), () =>
          HttpResponse.json([{ id: 1 }], { status: 200, headers: { 'x-total-count': '42' } }),
        ),
      );
      const { data, response } = await api.withResponse<Array<{ id: number }>>(url('/users'));

      expect(data).toEqual([{ id: 1 }]);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-total-count')).toBe('42');
      expect(response.bodyUsed).toBe(true);
    });

    it('withResponse でも HTTP エラーは HttpError を投げる', async () => {
      server.use(http.get(url('/users'), () => HttpResponse.json({ code: 'x' }, { status: 500 })));
      await expect(api.withResponse(url('/users'))).rejects.toBeInstanceOf(HttpError);
    });

    it('withResponse は 204 では data を undefined にする', async () => {
      server.use(http.post(url('/users'), () => new HttpResponse(null, { status: 204 })));
      const { data, response } = await api.withResponse(url('/users'), { method: 'POST', body: { a: 1 } });

      expect(data).toBeUndefined();
      expect(response.status).toBe(204);
    });

    it("responseType: 'response' はボディを読まずに Response を返す", async () => {
      server.use(http.get(url('/file'), () => HttpResponse.text('content')));
      const response = await api.get(url('/file'), { responseType: 'response' });

      expect(response).toBeInstanceOf(Response);
      expect(response.bodyUsed).toBe(false);
      await expect(response.text()).resolves.toBe('content');
    });

    it("responseType: 'response' でも HTTP エラーは解析済みのボディ付きで HttpError を投げる", async () => {
      server.use(http.get(url('/file'), () => HttpResponse.json({ code: 'gone' }, { status: 410 })));
      const error = await api(url('/file'), { responseType: 'response' }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).body).toEqual({ code: 'gone' });
    });
  });

  describe('インスタンス', () => {
    it('インスタンスごとに設定が独立している', async () => {
      server.use(http.get(url('/users'), () => HttpResponse.json([])));
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

      await createFetcher({ timeout: 1_000 }).get(url('/users'));
      await createFetcher({ timeout: 2_000 }).get(url('/users'));

      expect(timeoutSpy.mock.calls).toEqual([[1_000], [2_000]]);
    });
  });
});
