import { hostname } from 'node:os';
import { openStore } from './store.ts';
import { createApp } from './server.ts';

const store = await openStore();
const epoch = await store.claim(`${hostname()}:${process.pid}`);
const { server, close } = createApp({ store, speed: Number(process.env.WATCHSHIFT_SPEED ?? 1), tickMs: Number(process.env.WATCHSHIFT_TICK_MS ?? 250), trustProxyHops: Number(process.env.WATCHSHIFT_TRUST_PROXY_HOPS ?? 0) });
const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`[watchshift] listening on :${port} (store ${store.kind}, owner epoch ${epoch})`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => { await close(); await store.close(); process.exit(0); });
