// @swift ledger:workerGlobals
// A Worker in an iOS build, which the iOS kit cannot start yet; Android runs it (tests/worker).
// @refused `Worker` in an iOS build
declare global {
	interface ImportMeta {
		readonly url: string;
	}
}
const worker = new Worker(new URL('./1804-worker-refused-on-ios', import.meta.url));
worker.onmessage = (event: MessageEvent) => console.log(event.data);
worker.postMessage(1);
