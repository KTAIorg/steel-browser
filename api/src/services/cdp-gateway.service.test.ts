import { describe, expect, it, vi } from "vitest";
import { IncomingMessage, Server as HttpServer, ServerResponse } from "http";
import { WebSocket } from "ws";
import type { CDPService } from "./cdp/cdp.service.js";
import type { FastifyBaseLogger } from "fastify";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLogger as unknown as FastifyBaseLogger,
} as unknown as FastifyBaseLogger;

// ── upstream Chrome DevTools endpoint stub ──────────────────────────────
let upstreamTargets: Array<Record<string, unknown>> = [];
let upstream: HttpServer;

async function startUpstream(): Promise<number> {
  upstream = new HttpServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://upstream").pathname;
    if (pathname === "/json/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(upstreamTargets));
      return;
    }
    if (pathname === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Browser: "chrome-stub" }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  return (upstream.address() as { port: number }).port;
}

function stubCdpService(sessionTargetIds: string[]): CDPService {
  return {
    getAllPages: async () =>
      sessionTargetIds.map((id) => ({
        target: () => ({ _targetId: id }),
        url: () => "https://session.example/",
      })),
    proxyWebSocket: async () => {
      // Test only exercises denials; authorized upgrades are integration-tested.
    },
  } as unknown as CDPService;
}

/**
 * env.ts is parsed once at module load, so each test loads a fresh copy of the
 * gateway module with the desired CDP_TOKEN in the environment.
 */
async function startGateway(
  cdpService: CDPService,
  token: string | undefined,
): Promise<{ port: number; close: () => Promise<void> }> {
  const upstreamPort = await startUpstream();
  if (token === undefined) {
    delete process.env.CDP_TOKEN;
  } else {
    process.env.CDP_TOKEN = token;
  }
  vi.resetModules();
  const { CDPGateway } = await import("./cdp-gateway.service.js");
  const gateway = new CDPGateway({
    cdpService,
    logger: noopLogger,
    upstreamPort,
    upstreamHost: "127.0.0.1",
  });
  const port = 10000 + Math.floor(Math.random() * 40000);
  await gateway.listen(port, "127.0.0.1");
  return {
    port,
    close: async () => {
      await gateway.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      delete process.env.CDP_TOKEN;
      vi.resetModules();
    },
  };
}

describe("CDPGateway", () => {
  it("filters /json/list to the current session's page targets and strips webSocketDebuggerUrl", async () => {
    upstreamTargets = [
      {
        targetId: "A11CE5AA",
        type: "page",
        title: "Session page",
        url: "https://session.example/",
        attached: false,
        webSocketDebuggerUrl: "ws://upstream/devtools/page/A11CE5AA",
      },
      {
        targetId: "0BADF00D",
        type: "page",
        title: "Another session's page",
        url: "https://other.example/secret",
        attached: false,
        webSocketDebuggerUrl: "ws://upstream/devtools/page/0BADF00D",
      },
      {
        targetId: "WORKER1",
        type: "shared_worker",
        title: "worker",
        url: "https://session.example/worker.js",
        attached: false,
      },
    ];
    const gw = await startGateway(stubCdpService(["A11CE5AA"]), "test-token");
    try {
      const res = await fetch(`http://127.0.0.1:${gw.port}/json/list`, {
        headers: { "x-cdp-token": "test-token" },
      });
      expect(res.status).toBe(200);
      const targets = (await res.json()) as Array<Record<string, unknown>>;
      expect(targets).toHaveLength(1);
      expect(targets[0].targetId).toBe("A11CE5AA");
      expect(targets[0].webSocketDebuggerUrl).toBeUndefined();
    } finally {
      await gw.close();
    }
  });

  it("rejects unauthenticated /json/list when CDP_TOKEN is set", async () => {
    upstreamTargets = [];
    const gw = await startGateway(stubCdpService([]), "test-token");
    try {
      const res = await fetch(`http://127.0.0.1:${gw.port}/json/list`);
      expect(res.status).toBe(401);
    } finally {
      await gw.close();
    }
  });

  it("refuses CDP attach to a target outside the current session", async () => {
    const proxyCalls: string[] = [];
    const cdp = {
      getAllPages: async () => [{ target: () => ({ _targetId: "A11CE5AA" }) }],
      proxyWebSocket: async (_req: IncomingMessage, _socket: unknown, _head: Buffer) => {
        proxyCalls.push("proxy");
      },
    } as unknown as CDPService;
    const gw = await startGateway(cdp, "test-token");
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/devtools/page/0BADF00D`, {
          headers: { "x-cdp-token": "test-token" },
        });
        ws.on("unexpected-response", (_req: IncomingMessage, res: ServerResponse) => {
          expect(res.statusCode).toBe(403);
          resolve();
        });
        ws.on("error", () => resolve());
        setTimeout(() => reject(new Error("no response")), 5000);
      });
      expect(proxyCalls).toHaveLength(0);
    } finally {
      await gw.close();
    }
  });

  it("blocks /json/new regardless of authentication", async () => {
    const gw = await startGateway(stubCdpService([]), "test-token");
    try {
      const res = await fetch(`http://127.0.0.1:${gw.port}/json/new`, {
        headers: { "x-cdp-token": "test-token" },
      });
      expect(res.status).toBe(405);
    } finally {
      await gw.close();
    }
  });

  it("allows the browser-level endpoint to be delegated when authorized", async () => {
    const proxyCalls: string[] = [];
    const cdp = {
      getAllPages: async () => [],
      proxyWebSocket: async () => {
        proxyCalls.push("proxy");
      },
    } as unknown as CDPService;
    const gw = await startGateway(cdp, "test-token");
    try {
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/devtools/browser`, {
          headers: { "x-cdp-token": "test-token" },
        });
        ws.on("error", () => resolve());
        ws.on("unexpected-response", () => resolve());
        setTimeout(() => {
          ws.terminate();
          resolve();
        }, 1500);
      });
      expect(proxyCalls).toHaveLength(1);
    } finally {
      await gw.close();
    }
  });

  it("allows session-owned page WS upgrades when CDP_TOKEN matches", async () => {
    const proxyCalls: string[] = [];
    const cdp = {
      getAllPages: async () => [{ target: () => ({ _targetId: "A11CE5AA" }) }],
      proxyWebSocket: async () => {
        proxyCalls.push("proxy");
      },
    } as unknown as CDPService;
    const gw = await startGateway(cdp, "test-token");
    try {
      // The stub proxyWebSocket never completes the upgrade handshake, so the
      // socket will error out; what we assert is that it was delegated (not
      // denied with 403/401).
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/devtools/page/A11CE5AA`, {
          headers: { "x-cdp-token": "test-token" },
        });
        ws.on("error", () => resolve());
        ws.on("unexpected-response", () => resolve());
        setTimeout(() => {
          ws.terminate();
          resolve();
        }, 1500);
      });
      expect(proxyCalls).toHaveLength(1);
    } finally {
      await gw.close();
    }
  });
});
