import path from 'node:path';
import { createDocumentStore } from './lib/store.js';
import { createExternalBridge } from './lib/external.js';
import { createApi } from './lib/api.js';
import { registerTools } from './lib/tools.js';

export const name = 'office-workbench';
export const inject = ['tools', 'webServer'];

export function apply(ctx, config = {}) {
  const dataRoot = path.resolve(config.dataRoot || path.join(process.env.HOME || process.cwd(), '.dsh', 'office-workbench'));
  const store = createDocumentStore(dataRoot);
  const external = createExternalBridge({
    store,
    directory: path.join(dataRoot, 'external'),
    app: config.externalApp || undefined,
    launch: config.launch || undefined,
  });
  ctx.effect(() => {
    const disposers = [
      registerTools(ctx, store, external),
      ctx.webServer.register({ kind: 'prefix', path: '/office-workbench', handler: createApi(store, external) }),
    ];
    void store.init().catch((error) => ctx.logger?.error?.(`[office-workbench] 初始化失败：${error.message}`));
    return () => { for (const dispose of disposers.reverse()) dispose(); };
  });
}
