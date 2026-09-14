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
 * gateway module with the desired CDP_TOKEN / CDP_ALLOW_ANONYMOUS in the
 * environment.
 */
async function loadGatewayModule(opts: {
  token?: string;
  allowAnonymous?: boolean;
}): Promise<typeof import("./cdp-gateway.service.js")> {
  if (opts.token === undefined) {
    delete process.env.CDP_TOKEN;
  } else {
    process.env.CDP_TOKEN = opts.token;
  }
  if (opts.allowAnonymous) {
    process.env.CDP_ALLOW_ANONYMOUS = "true";
  } else {
    delete process.env.CDP_ALLOW_ANONYMOUS;
  }
  vi.resetModules();
  return import("./cdp-gateway.service.js");
}

function clearGatewayEnv(): void {
  delete process.env.CDP_TOKEN;
  delete process.env.CDP_ALLOW_ANONYMOUS;
  vi.resetModules();
}

async function startGateway(
  cdpService: CDPService,
  token: string | undefined,
  opts: { allowAnonymous?: boolean; bindHost?: string } = {},
): Promise<{ port: number; boundHost: string | null; close: () => Promise<void> }> {
  const upstreamPort = await startUpstream();
  const { CDPGateway } = await loadGatewayModule({ token, allowAnonymous: opts.allowAnonymous });
  const gateway = new CDPGateway({
    cdpService,
    logger: noopLogger,
    upstreamPort,
    upstreamHost: "127.0.0.1",
  });
  const port = 10000 + Math.floor(Math.random() * 40000);
  await gateway.listen(port, opts.bindHost ?? "127.0.0.1");
  return {
    port,
    boundHost: gateway.boundHost,
    close: async () => {
      await gateway.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      clearGatewayEnv();
    },
  };
}

describe("CDPGateway", () => {
  it("filters /json/list to the current session's page targets and strips both WS-bearing fields", async () => {
    // Real Chrome /json/list shape: the target id is spelled `id` (not
    // `targetId`), and `devtoolsFrontendUrl` carries the same /devtools/page/
    // path in its ?ws= query as `webSocketDebuggerUrl` does.
    upstreamTargets = [
      {
        description: "",
        devtoolsFrontendUrl: "/devtools/inspector.html?ws=127.0.0.1:9222/devtools/page/A11CE5AA",
        id: "A11CE5AA",
        title: "Session page",
        type: "page",
        url: "https://session.example/",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/A11CE5AA",
      },
      {
        description: "",
        devtoolsFrontendUrl: "/devtools/inspector.html?ws=127.0.0.1:9222/devtools/page/0BADF00D",
        id: "0BADF00D",
        title: "Another session's page",
        url: "https://other.example/secret",
        type: "page",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/0BADF00D",
      },
      {
        description: "",
        devtoolsFrontendUrl: "/devtools/inspector.html?ws=127.0.0.1:9222/devtools/page/WORKER1",
        id: "WORKER1",
        title: "worker",
        type: "shared_worker",
        url: "https://session.example/worker.js",
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
      expect(targets[0].id).toBe("A11CE5AA");
      expect(targets[0].targetId).toBe("A11CE5AA");
      // Allowlist projection: nothing but the declared fields survives, so no
      // future upstream field can silently re-leak a reachable WS endpoint.
      expect(Object.keys(targets[0]).sort()).toEqual(["id", "targetId", "title", "type", "url"]);
      expect(targets[0].webSocketDebuggerUrl).toBeUndefined();
      expect(targets[0].devtoolsFrontendUrl).toBeUndefined();
      expect(JSON.stringify(targets)).not.toContain("devtools/page/A11CE5AA");
    } finally {
      await gw.close();
    }
  });

  it("matches session targets when upstream reports targetId instead of id", async () => {
    upstreamTargets = [
      { targetId: "A11CE5AA", type: "page", title: "t", url: "https://session.example/" },
    ];
    const gw = await startGateway(stubCdpService(["A11CE5AA"]), "test-token");
    try {
      const res = await fetch(`http://127.0.0.1:${gw.port}/json/list`, {
        headers: { "x-cdp-token": "test-token" },
      });
      const targets = (await res.json()) as Array<Record<string, unknown>>;
      expect(targets).toHaveLength(1);
      expect(targets[0].id).toBe("A11CE5AA");
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

  it("refuses to start when CDP_TOKEN is unset and CDP_ALLOW_ANONYMOUS is not enabled", async () => {
    const { CDPGateway } = await loadGatewayModule({});
    const gateway = new CDPGateway({ cdpService: stubCdpService([]), logger: noopLogger });
    await expect(gateway.listen(0, "0.0.0.0")).rejects.toThrow(/CDP_TOKEN is not set/);
    clearGatewayEnv();
  });

  it("binds loopback only and serves anonymous requests when CDP_ALLOW_ANONYMOUS=true", async () => {
    upstreamTargets = [
      { id: "A11CE5AA", type: "page", title: "t", url: "https://session.example/" },
    ];
    const gw = await startGateway(stubCdpService(["A11CE5AA"]), undefined, {
      allowAnonymous: true,
      bindHost: "0.0.0.0",
    });
    try {
      // The caller asked for a routable bind; the policy must have downgraded it.
      expect(gw.boundHost).toBe("127.0.0.1");
      const res = await fetch(`http://127.0.0.1:${gw.port}/json/list`);
      expect(res.status).toBe(200);
      expect(await res.json()).toHaveLength(1);
    } finally {
      await gw.close();
    }
  });

  it("denies /devtools/browser without a token, even though it is not target-scoped", async () => {
    const proxyCalls: string[] = [];
    const cdp = {
      getAllPages: async () => [],
      proxyWebSocket: async () => {
        proxyCalls.push("proxy");
      },
    } as unknown as CDPService;
    const gw = await startGateway(cdp, "test-token");
    try {
      // The browser endpoint reaches every target in the process via
      // Target.getTargets / Target.attachToTarget, so it must be authenticated.
      const status = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/devtools/browser`);
        ws.on("unexpected-response", (_req: IncomingMessage, res: ServerResponse) =>
          resolve(res.statusCode ?? 0),
        );
        ws.on("open", () => {
          ws.terminate();
          resolve(101);
        });
        ws.on("error", () => resolve(0));
        setTimeout(() => {
          ws.terminate();
          resolve(-1);
        }, 3000);
      });
      expect(status).toBe(401);
      expect(proxyCalls).toHaveLength(0);
    } finally {
      await gw.close();
    }
  });

  it("returns 405 for /json/new without consulting upstream", async () => {
    const { CDPGateway } = await loadGatewayModule({ token: "test-token" });
    const gateway = new CDPGateway({
      cdpService: stubCdpService([]),
      logger: noopLogger,
      upstreamHost: "127.0.0.1",
      upstreamPort: 1,
    });
    const port = 10000 + Math.floor(Math.random() * 40000);
    await gateway.listen(port, "127.0.0.1");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/new`, {
        headers: { "x-cdp-token": "test-token" },
      });
      expect(res.status).toBe(405);
    } finally {
      await gateway.close();
      clearGatewayEnv();
    }
  });
});

describe("resolveCDPGatewayBindPolicy", () => {
  it("keeps the requested bind address when a token is configured", async () => {
    const mod = await loadGatewayModule({ token: "test-token" });
    expect(mod.resolveCDPGatewayBindPolicy("0.0.0.0")).toEqual({
      host: "0.0.0.0",
      anonymous: false,
    });
    clearGatewayEnv();
  });

  it("throws when neither CDP_TOKEN nor CDP_ALLOW_ANONYMOUS is set", async () => {
    const mod = await loadGatewayModule({});
    expect(() => mod.resolveCDPGatewayBindPolicy("0.0.0.0")).toThrow(/CDP_TOKEN is not set/);
    clearGatewayEnv();
  });

  it("downgrades to loopback when CDP_ALLOW_ANONYMOUS is set without a token", async () => {
    const mod = await loadGatewayModule({ allowAnonymous: true });
    expect(mod.resolveCDPGatewayBindPolicy("0.0.0.0")).toEqual({
      host: "127.0.0.1",
      anonymous: true,
    });
    clearGatewayEnv();
  });
});
