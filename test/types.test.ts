/**
 * 公開 API の型のテスト。
 *
 * 検査は `tsc --noEmit` で行う(`@ts-expect-error` の行に型エラーが出なければ tsc が失敗する)。
 * 下の関数は呼び出さないため、実行時にリクエストは送られない。
 */
import { describe, expectTypeOf, it } from 'vitest';
import type {
  AbortError,
  Fetcher,
  FetcherOptions,
  FetcherResponse,
  HttpError,
  NetworkError,
  ParseError,
  TimeoutError,
} from '../src/index.js';

interface User {
  id: number;
  name: string;
}

/** interface で宣言した DTO(Record<string, unknown> では受け付けられない形) */
interface CreateUserRequest {
  name: string;
}

function typeChecks(api: Fetcher, dto: CreateUserRequest): void {
  // 戻り値: 型引数がなければ unknown、指定すればその型
  expectTypeOf(api('/users')).toEqualTypeOf<Promise<unknown>>();
  expectTypeOf(api<User>('/users/1')).toEqualTypeOf<Promise<User>>();
  expectTypeOf(api.get<User[]>('/users')).toEqualTypeOf<Promise<User[]>>();
  expectTypeOf(api.post<User>('/users', { body: dto })).toEqualTypeOf<Promise<User>>();
  expectTypeOf(api.post('/upload', { body: new FormData() })).toEqualTypeOf<Promise<unknown>>();

  // responseType: 'response' のときだけ Response を返す
  expectTypeOf(api.get('/file', { responseType: 'response' })).toEqualTypeOf<Promise<Response>>();
  expectTypeOf(api('/file', { method: 'HEAD', responseType: 'response' })).toEqualTypeOf<Promise<Response>>();
  expectTypeOf(api.get('/file', { responseType: 'blob' })).toEqualTypeOf<Promise<unknown>>();

  // withResponse
  expectTypeOf(api.withResponse<User>('/users/1')).toEqualTypeOf<Promise<FetcherResponse<User>>>();

  // FetcherOptions 型の変数をそのまま渡せる
  const options: FetcherOptions = { timeout: 1_000, headers: { 'X-Trace': '1' } };
  expectTypeOf(api('/users', options)).toEqualTypeOf<Promise<unknown>>();

  // エラーの name はリテラル型で、判別に使える
  expectTypeOf<HttpError['name']>().toEqualTypeOf<'HttpError'>();
  expectTypeOf<NetworkError['name']>().toEqualTypeOf<'NetworkError'>();
  expectTypeOf<TimeoutError['name']>().toEqualTypeOf<'TimeoutError'>();
  expectTypeOf<AbortError['name']>().toEqualTypeOf<'AbortError'>();
  expectTypeOf<ParseError['name']>().toEqualTypeOf<'ParseError'>();

  // @ts-expect-error GET にはボディを指定できない
  void api.get('/users', { body: { a: 1 } });
  // @ts-expect-error メソッド別の関数では method を指定できない
  void api.post('/users', { method: 'GET' });
  // @ts-expect-error 型引数を指定した呼び出しでは 'response' を使えない(戻り値が Response になるため)
  void api.get<User>('/file', { responseType: 'response' });
  // @ts-expect-error withResponse では 'response' を使えない
  void api.withResponse('/file', { responseType: 'response' });
  // @ts-expect-error 未対応の responseType
  void api.get('/file', { responseType: 'xml' });
  // @ts-expect-error timeout は数値か false
  void api.get('/users', { timeout: true });
  // @ts-expect-error ボディに数値は渡せない
  void api.post('/users', { body: 42 });
}

describe('型定義', () => {
  it('tsc --noEmit で検査する', () => {
    expectTypeOf(typeChecks).toBeFunction();
  });
});
