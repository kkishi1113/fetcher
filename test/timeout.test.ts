import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIMEOUT_MS } from '../src/defaults.js';
import { AbortError, createFetcher, FetcherError, HttpError, TimeoutError } from '../src/index.js';
import { createRequestSignal, raceSignal, validateTimeout } from '../src/timeout.js';
import {
  catchError,
  deferred,
  endlessStream,
  hang,
  spyFetch,
  track,
  url,
  useFakeTimeout,
} from './support/helpers.js';
import { server } from './support/server.js';

const ONE_HOUR_MS = 60 * 60 * 1_000;

describe('validateTimeout', () => {
  it('正の有限数と false を受け付ける', () => {
    expect(validateTimeout(1)).toBe(1);
    expect(validateTimeout(0.5)).toBe(0.5);
    expect(validateTimeout(false)).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('%s は RangeError にする', (timeout) => {
    expect(() => validateTimeout(timeout)).toThrow(RangeError);
  });
});

describe('createRequestSignal', () => {
  it('呼び出し側の signal もタイムアウトもなければ signal を作らない', () => {
    const requestSignal = createRequestSignal(undefined, false);
    expect(requestSignal.signal).toBeUndefined();
    expect(requestSignal.abortCause()).toBeUndefined();
  });

  it('呼び出し側の signal だけなら、それをそのまま使う', () => {
    const controller = new AbortController();
    const requestSignal = createRequestSignal(controller.signal, false);

    expect(requestSignal.signal).toBe(controller.signal);
    controller.abort();
    expect(requestSignal.abortCause()).toEqual({ type: 'abort' });
  });

  it('タイムアウトは AbortSignal.timeout() で作る', async () => {
    useFakeTimeout();
    const requestSignal = createRequestSignal(null, 1_000);

    expect(AbortSignal.timeout).toHaveBeenCalledWith(1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(requestSignal.abortCause()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(requestSignal.abortCause()).toEqual({ type: 'timeout', timeout: 1_000 });
  });

  it('両方あるとき、先にタイムアウトしたら後からキャンセルされても timeout と判定する', async () => {
    useFakeTimeout();
    const controller = new AbortController();
    const requestSignal = createRequestSignal(controller.signal, 1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    expect(requestSignal.abortCause()).toEqual({ type: 'timeout', timeout: 1_000 });
  });

  it('両方あるとき、先にキャンセルされたら後からタイムアウトしても abort と判定する', async () => {
    useFakeTimeout();
    const controller = new AbortController();
    const requestSignal = createRequestSignal(controller.signal, 1_000);

    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestSignal.abortCause()).toEqual({ type: 'abort' });
  });

  it('呼び出し側が自分で渡したタイムアウト signal は、呼び出し側の中断として扱う', async () => {
    useFakeTimeout();
    const requestSignal = createRequestSignal(AbortSignal.timeout(500), 1_000);

    await vi.advanceTimersByTimeAsync(500);
    expect(requestSignal.abortCause()).toEqual({ type: 'abort' });
  });
});

describe('raceSignal', () => {
  it('signal がなければ元の Promise をそのまま返す', () => {
    const promise = Promise.resolve(1);
    expect(raceSignal(promise, undefined)).toBe(promise);
  });

  it('中断されなければ元の結果を返し、リスナーを外す', async () => {
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');

    await expect(raceSignal(Promise.resolve('ok'), controller.signal)).resolves.toBe('ok');
    await expect(raceSignal(Promise.reject(new Error('fail')), controller.signal)).rejects.toThrow('fail');
    expect(removeEventListener).toHaveBeenCalledTimes(2);
  });

  it('中断されたら、元の Promise を待たずに reason で reject する', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    const pending = raceSignal(new Promise<never>(() => {}), controller.signal);

    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('中断済みの signal ならすぐに reject し、元の Promise の失敗を未処理にしない', async () => {
    const controller = new AbortController();
    controller.abort();
    const original = Promise.reject(new Error('later failure'));

    await expect(raceSignal(original, controller.signal)).rejects.toBe(controller.signal.reason);
  });
});

describe('タイムアウトとキャンセル', () => {
  it(`既定では ${DEFAULT_TIMEOUT_MS}ms でタイムアウトする(境界値)`, async () => {
    useFakeTimeout();
    server.use(http.get(url('/slow'), hang));
    const promise = createFetcher().get(url('/slow'));
    const state = track(promise);
    const caught = catchError(promise);

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await caught;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ name: 'TimeoutError', timeout: DEFAULT_TIMEOUT_MS, method: 'GET', url: url('/slow') });
    expect((error as TimeoutError).cause).toMatchObject({ name: 'TimeoutError' });
  });

  it('リクエスト単位で上書きできる', async () => {
    useFakeTimeout();
    server.use(http.get(url('/slow'), hang));
    const promise = createFetcher().get(url('/slow'), { timeout: 500 });
    const state = track(promise);
    const caught = catchError(promise);

    await vi.advanceTimersByTimeAsync(499);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(caught).resolves.toMatchObject({ name: 'TimeoutError', timeout: 500 });
  });

  it('createFetcher の設定で既定値を変えられる', async () => {
    useFakeTimeout();
    server.use(http.get(url('/slow'), hang));
    const caught = catchError(createFetcher({ timeout: 3_000 }).get(url('/slow')));

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(caught).resolves.toMatchObject({ name: 'TimeoutError', timeout: 3_000 });
  });

  it('timeout: false で、設定値があってもリクエスト単位で無効にできる', async () => {
    useFakeTimeout();
    const gate = deferred();
    server.use(
      http.get(url('/long'), async () => {
        await gate.promise;
        return HttpResponse.json({ done: true });
      }),
    );
    const promise = createFetcher({ timeout: 1_000 }).get(url('/long'), { timeout: false });
    const state = track(promise);

    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS);
    expect(state.settled).toBe(false);
    expect(AbortSignal.timeout).not.toHaveBeenCalled();

    gate.resolve();
    await expect(promise).resolves.toEqual({ done: true });
  });

  it('createFetcher({ timeout: false }) で全体を無効にし、リクエスト単位で有効にできる', async () => {
    useFakeTimeout();
    server.use(http.get(url('/slow'), hang));
    const api = createFetcher({ timeout: false });
    const unlimited = track(api.get(url('/slow')));
    const caught = catchError(api.get(url('/slow'), { timeout: 1_000 }));

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(caught).resolves.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS);
    expect(unlimited.settled).toBe(false);
  });

  it('不正な timeout は設定時に RangeError を投げ、リクエスト時は RangeError で reject する', async () => {
    expect(() => createFetcher({ timeout: 0 })).toThrow(RangeError);
    expect(() => createFetcher({ timeout: Number.NaN })).toThrow(RangeError);

    const error = await createFetcher().get(url('/users'), { timeout: -1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RangeError);
    expect(error).not.toBeInstanceOf(FetcherError);
  });

  it('呼び出し側のキャンセルは AbortError にし、name でも判定でき、reason を cause に保持する', async () => {
    server.use(http.get(url('/slow'), hang));
    const controller = new AbortController();
    const reason = new Error('user navigated away');
    const caught = catchError(createFetcher().get(url('/slow'), { signal: controller.signal }));

    controller.abort(reason);
    const error = await caught;

    expect(error).toBeInstanceOf(AbortError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect((error as Error).name).toBe('AbortError');
    expect((error as AbortError).cause).toBe(reason);
  });

  it('中断済みの signal ならリクエストを送らずに AbortError にする', async () => {
    const handler = vi.fn(() => HttpResponse.json({}));
    server.use(http.get(url('/users'), handler));

    await expect(createFetcher().get(url('/users'), { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('呼び出し側の signal があっても、タイムアウトなら TimeoutError にする', async () => {
    useFakeTimeout();
    server.use(http.get(url('/slow'), hang));
    const controller = new AbortController();
    const caught = catchError(createFetcher().get(url('/slow'), { signal: controller.signal, timeout: 1_000 }));

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(caught).resolves.toBeInstanceOf(TimeoutError);
  });

  it('タイムアウト前にキャンセルされたら AbortError にする', async () => {
    useFakeTimeout();
    server.use(http.get(url('/slow'), hang));
    const controller = new AbortController();
    const caught = catchError(createFetcher().get(url('/slow'), { signal: controller.signal, timeout: 1_000 }));

    await vi.advanceTimersByTimeAsync(999);
    controller.abort();
    await expect(caught).resolves.toBeInstanceOf(AbortError);
  });

  it('ボディの読み取り中もタイムアウトする', async () => {
    useFakeTimeout();
    const fetchSpy = spyFetch();
    server.use(
      http.get(url('/stream'), () =>
        new HttpResponse(endlessStream('{"a":'), { headers: { 'content-type': 'application/json' } }),
      ),
    );
    const promise = createFetcher().get(url('/stream'), { timeout: 1_000 });
    const state = track(promise);
    const caught = catchError(promise);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchSpy.responded()).toBe(true);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(caught).resolves.toBeInstanceOf(TimeoutError);
  });

  it('ボディの読み取り中のキャンセルは AbortError にする', async () => {
    const fetchSpy = spyFetch();
    server.use(
      http.get(url('/stream'), () =>
        new HttpResponse(endlessStream('partial'), { headers: { 'content-type': 'text/plain' } }),
      ),
    );
    const controller = new AbortController();
    const caught = catchError(createFetcher().get(url('/stream'), { signal: controller.signal }));

    await vi.waitFor(() => expect(fetchSpy.responded()).toBe(true));
    controller.abort();
    await expect(caught).resolves.toBeInstanceOf(AbortError);
  });

  it('HTTP エラーのボディ読み取り中にタイムアウトしたら、HttpError ではなく TimeoutError にする', async () => {
    useFakeTimeout();
    const fetchSpy = spyFetch();
    server.use(
      http.get(url('/error-stream'), () =>
        new HttpResponse(endlessStream('{"code":'), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const caught = catchError(createFetcher().get(url('/error-stream'), { timeout: 1_000 }));

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchSpy.responded()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const error = await caught;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).not.toBeInstanceOf(HttpError);
  });

  it('タイムアウト前に完了すれば、その後に時間が経過しても影響しない', async () => {
    useFakeTimeout();
    server.use(http.get(url('/fast'), () => HttpResponse.json({ ok: true })));

    await expect(createFetcher().get(url('/fast'))).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS * 2);
  });
});
