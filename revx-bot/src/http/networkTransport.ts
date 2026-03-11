import dns from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";

let initialized = false;

export function initNetworkTransport(): void {
  if (initialized) return;
  initialized = true;

  dns.setDefaultResultOrder("ipv4first");

  const dispatcher = new Agent({
    connections: 16,
    pipelining: 1,
    keepAliveTimeout: 15_000,
    keepAliveMaxTimeout: 60_000
  });
  setGlobalDispatcher(dispatcher);
}
