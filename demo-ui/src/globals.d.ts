declare interface WorkerOptions {
  credentials?: RequestCredentials;
  name?: string;
  type?: "classic" | "module";
}

declare class Worker extends EventTarget {
  constructor(scriptURL: string | URL, options?: WorkerOptions);
  onmessage: ((this: Worker, event: MessageEvent) => unknown) | null;
  onmessageerror: ((this: Worker, event: MessageEvent) => unknown) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}
