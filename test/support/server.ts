import { setupServer } from 'msw/node';

/** テスト全体で共有する MSW サーバー。ハンドラーは各テストで server.use() する */
export const server = setupServer();
