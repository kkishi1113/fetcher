import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { server } from './support/server.js';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
});
afterAll(() => server.close());
