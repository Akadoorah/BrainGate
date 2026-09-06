import { createServer, type Server } from "node:http";
import type { DashboardSnapshot } from "@braingate/observability";
import { renderDashboardHtml } from "./render.js";

export class DashboardBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardBindError";
  }
}

export function assertLoopbackHost(host: string): void {
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new DashboardBindError(`BrainGate dashboard may bind only to loopback; refused ${host}.`);
  }
}

export function createDashboardServer(snapshotProvider: () => DashboardSnapshot): Server {
  return createServer((request, response) => {
    if (request.method !== "GET" || (request.url ?? "/") !== "/") {
      response.statusCode = 404;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("Not found");
      return;
    }
    const html = renderDashboardHtml(snapshotProvider());
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader("x-content-type-options", "nosniff");
    response.end(html);
  });
}

export async function startDashboardServer(
  snapshotProvider: () => DashboardSnapshot,
  options: { readonly host?: string; readonly port?: number } = {},
): Promise<{ readonly server: Server; readonly url: string }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  assertLoopbackHost(host);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError("Dashboard port must be an integer from 0 to 65535.");
  const server = createDashboardServer(snapshotProvider);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new DashboardBindError("Dashboard server did not receive a TCP loopback address.");
  }
  const printableHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return Object.freeze({ server, url: `http://${printableHost}:${address.port}/` });
}
