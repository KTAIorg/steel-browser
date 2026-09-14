import { FastifyBaseLogger } from "fastify";
import { IncomingMessage, Server as HttpServer, ServerResponse } from "http";
import { Duplex } from "stream";
import { timingSafeEqual as cryptoTimingSafeEqual } from "crypto";
import { env } from "../env.js";
import { CDPService } from "./cdp/cdp.service.js";

const FORBIDDEN_TARGET_TYPES = new Set(["iframe", "shared_worker", "service_worker", "worker"]);

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Consume a comparison anyway so failure timing does not leak length info.
    cryptoTimingSafeEqual(ab, ab);
    return false;
  }
  return cryptoTimingSafeEqual(ab, bb);
}

interface TargetInfo {
  /** Chrome's /json/list spells the target id `id`; Target.getTargets uses `targetId`. */
  id?: string;
  targetId?: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
}

export interface CDPGatewayConfig {
  cdpService: CDPService;
  logger: FastifyBaseLogger;
  /** Upstream is the Chrome DevTools HTTP endpoint (127.0.0.1:9222). */
  upstreamHost?: string;
  upstreamPort?: number;
}

export interface CDPGatewayBindPolicy {
  /** Address the public CDP surface binds to. */
  host: string;
  /** True when requests carrying no token are accepted (loopback bind only). */
  anonymous: boolean;
}

/**
 * Decide where the public CDP surface may bind, and whether it may serve
 * unauthenticated requests at all.
 *
 * Fails closed. Without CDP_TOKEN this gateway would hand out /devtools/browser,
 * which is the highest-privilege surface of the whole Chrome process:
 * Target.getTargets enumerates every target in it and
 * Target.attachToTarget{flatten:true} takes over any of them, cookies and
 * logged-in state included. Since one container carries one tenant's browser
 * session and profile, "unauthenticated CDP" means "unauthenticated access to
 * that tenant's logins". So the tokenless mode only exists behind an explicit
 * CDP_ALLOW_ANONYMOUS opt-in, and only ever on loopback.
 *
 * @throws when no token is configured and anonymous mode was not opted into.
 */
export function resolveCDPGatewayBindPolicy(
  requestedHost: string,
  overrides: { token?: string; allowAnonymous?: boolean } = {},
): CDPGatewayBindPolicy {
  const token = overrides.token ?? env.CDP_TOKEN;
  const allowAnonymous = overrides.allowAnonymous ?? env.CDP_ALLOW_ANONYMOUS;
  if (token) {
    return { host: requestedHost, anonymous: false };
  }
  if (!allowAnonymous) {
    throw new Error(
      "[CDPGateway] refusing to start: CDP_TOKEN is not set. The CDP surface " +
        "exposes /devtools/browser, from which any target of this Chrome process " +
        "can be enumerated and attached to. Set CDP_TOKEN (required for any " +
        "multi-tenant or network-reachable deployment), or set " +
        "CDP_ALLOW_ANONYMOUS=true to serve it on 127.0.0.1 only.",
    );
  }
  return { host: "127.0.0.1", anonymous: true };
}

/**
 * Session-scoped gateway for the Chrome DevTools HTTP endpoint.
 *
 * Plain nginx passthrough exposes Chrome's own /json/list to anyone who can
 * reach port 9223, letting a client enumerate every target of every session
 * (URLs and titles included) and hijack any webSocketDebuggerUrl. This gateway
 * rewrites the plain-HTTP surface instead:
 *  - every request must present the instance CDP token (query or header), and
 *    the gateway refuses to start at all when no token is configured unless
 *    CDP_ALLOW_ANONYMOUS=true, which pins it to loopback;
 *  - /json and /json/list only return targets belonging to the current
 *    session's pages, and only page-type targets;
 *  - responses are an explicit allowlist projection, so neither
 *    webSocketDebuggerUrl nor devtoolsFrontendUrl (whose `?ws=` query carries
 *    the same WS path) leaks; clients get WS endpoints from the authenticated
 *    API (`/v1/devtools/inspector.html` or the session websocket URL) instead of
 *    the raw enumeration surface.
 *
 * The token is instance-scoped, not per-session: it proves "may drive this
 * container's browser", which under the KT model (1 container = 1 Chrome = 1
 * tenant session, scale out by replicas) is the whole trust boundary. Per-target
 * filtering additionally confines a token holder to this session's page targets
 * on /devtools/page/<id>; /devtools/browser is deliberately not target-scoped
 * because CDP clients (puppeteer, playwright, chromedp) attach there first.
 */
export class CDPGateway {
  private logger: FastifyBaseLogger;
  private cdpService: CDPService;
  private server: HttpServer | null = null;
  private readonly upstreamPort: number;
  private readonly upstreamHost: string;
  private openSockets = new Set<Duplex>();
  /** Set only by listen() when CDP_ALLOW_ANONYMOUS pinned us to loopback. */
  private anonymousAllowed = false;
  private bindHost: string | null = null;

  constructor(config: CDPGatewayConfig) {
    this.cdpService = config.cdpService;
    this.logger = config.logger.child({ component: "CDPGateway" });
    this.upstreamHost = config.upstreamHost ?? "127.0.0.1";
    this.upstreamPort = config.upstreamPort ?? 9222;
  }

  /** Address the public CDP surface is actually bound to (null before listen). */
  public get boundHost(): string | null {
    return this.bindHost;
  }

  public async listen(port: number, host: string): Promise<void> {
    if (this.server) {
      return;
    }
    const policy = resolveCDPGatewayBindPolicy(host);
    this.anonymousAllowed = policy.anonymous;
    this.bindHost = policy.host;
    this.server = new HttpServer(this.handleRequest.bind(this));
    this.server.on("upgrade", this.handleUpgrade.bind(this));
    this.server.on("connection", (socket) => {
      this.openSockets.add(socket);
      socket.on("close", () => this.openSockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, policy.host, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    if (policy.anonymous) {
      this.logger.warn(
        `[CDPGateway] CDP_TOKEN is not set: serving unauthenticated CDP on loopback only ` +
          `(${policy.host}:${port}) because CDP_ALLOW_ANONYMOUS=true. Not safe to expose.`,
      );
    }
    this.logger.info(
      `[CDPGateway] listening on ${policy.host}:${port} (upstream ${this.upstreamHost}:${
        this.upstreamPort
      }, token ${policy.anonymous ? "not required (loopback)" : "required"})`,
    );
  }

  public async close(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    this.bindHost = null;
    // Sockets handed to the 'upgrade' path are not tracked by
    // closeAllConnections() until the handshake completes; destroy them
    // explicitly so close() cannot hang on half-open CDP connections.
    for (const socket of this.openSockets) {
      socket.destroy();
    }
    this.openSockets.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private isAuthorized(req: IncomingMessage, url: URL): boolean {
    const token = env.CDP_TOKEN;
    if (!token) {
      // Fail closed. Reaching this branch with anonymousAllowed set means
      // listen() pinned the socket to loopback under CDP_ALLOW_ANONYMOUS.
      return this.anonymousAllowed;
    }
    const header = req.headers["x-cdp-token"];
    const provided =
      (Array.isArray(header) ? header[0] : header) || url.searchParams.get("token") || "";
    if (!provided) {
      return false;
    }
    return timingSafeEqual(provided, token);
  }

  private deny(res: ServerResponse, code: number, message: string): void {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }

  /** Target IDs that belong to the current session (its open pages). */
  private async sessionTargetIds(): Promise<Set<string> | null> {
    try {
      const pages = await this.cdpService.getAllPages();
      const ids = new Set<string>();
      for (const page of pages) {
        try {
          //@ts-ignore
          ids.add(page.target()._targetId);
        } catch {
          // page already closed
        }
      }
      return ids;
    } catch (err) {
      this.logger.debug({ err }, "[CDPGateway] failed to list session pages");
      return null;
    }
  }

  private async fetchUpstreamJson(pathname: string): Promise<TargetInfo[] | null> {
    const res = await fetch(`http://${this.upstreamHost}:${this.upstreamPort}${pathname}`, {
      headers: { Host: `${this.upstreamHost}:${this.upstreamPort}` },
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as TargetInfo[];
  }

  /** Chrome's /json/list spells it `id`, Target.getTargets `targetId`; accept both. */
  private static targetIdOf(t: TargetInfo): string {
    return t.targetId ?? t.id ?? "";
  }

  private rewriteList(targets: TargetInfo[], allowed: Set<string> | null): TargetInfo[] {
    if (!allowed) {
      return [];
    }
    return targets
      .filter((t) => allowed.has(CDPGateway.targetIdOf(t)))
      .filter((t) => !FORBIDDEN_TARGET_TYPES.has(t.type))
      .map((t) => {
        const id = CDPGateway.targetIdOf(t);
        // Explicit allowlist projection, never spread-minus-one: Chrome's
        // /json/list also carries devtoolsFrontendUrl, whose ?ws= query holds
        // the very same /devtools/page/<id> path that webSocketDebuggerUrl does.
        return {
          id,
          targetId: id,
          type: t.type,
          title: t.title,
          url: t.url,
          ...(t.attached === undefined ? {} : { attached: t.attached }),
        };
      });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (!this.isAuthorized(req, url)) {
        this.deny(res, 401, "unauthorized");
        return;
      }
      const pathname = url.pathname.replace(/\/$/, "");
      if (pathname === "/json/new") {
        this.deny(res, 405, "target creation is not exposed");
        return;
      }
      if (pathname === "/json" || pathname === "/json/list") {
        const [targets, allowed] = await Promise.all([
          this.fetchUpstreamJson("/json/list"),
          this.sessionTargetIds(),
        ]);
        if (!targets) {
          this.deny(res, 502, "chrome devtools endpoint unavailable");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(this.rewriteList(targets, allowed)));
        return;
      }
      if (pathname === "/json/version" || pathname === "/json/protocol") {
        const upstream = await fetch(`http://${this.upstreamHost}:${this.upstreamPort}${pathname}`);
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        res.end(await upstream.text());
        return;
      }
      this.deny(res, 404, "not found");
    } catch (err) {
      this.logger.error({ err }, "[CDPGateway] request error");
      if (!res.headersSent) {
        this.deny(res, 500, "internal error");
      } else {
        res.end();
      }
    }
  }

  /**
   * WebSocket upgrade gate. Every path is authenticated first; then only CDP
   * page targets of the current session and the browser endpoint may pass, and
   * everything else is denied by default.
   */
  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (!this.isAuthorized(req, url)) {
      this.denySocket(socket, 401);
      return;
    }
    // The browser-level endpoint is required by CDP clients (puppeteer,
    // playwright, chromedp all attach to it first), so it cannot be
    // target-scoped. It is NOT a low-privilege endpoint: Target.getTargets
    // enumerates every target in the Chrome process and
    // Target.attachToTarget{flatten:true} takes over any of them, cookies and
    // logged-in state included. Holding the token therefore means holding this
    // container's whole browser -- which is why an unauthenticated gateway is
    // refused at startup (see resolveCDPGatewayBindPolicy) rather than allowed
    // to reach this branch.
    if (url.pathname === "/devtools/browser") {
      await this.delegate(req, socket, head);
      return;
    }
    const match = url.pathname.match(/^\/devtools\/page\/([A-Fa-f0-9]{8,64})$/);
    if (!match) {
      this.denySocket(socket, 404);
      return;
    }
    const allowed = await this.sessionTargetIds();
    if (!allowed || !allowed.has(match[1])) {
      // Fail closed: if the session's pages cannot be enumerated, deny rather
      // than risk handing a foreign session's target to this client.
      this.logger.warn(
        `[CDPGateway] refused CDP attach to non-session target ${match[1]} from ${req.socket.remoteAddress}`,
      );
      this.denySocket(socket, 403);
      return;
    }
    await this.delegate(req, socket, head);
  }

  private async delegate(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      await this.cdpService.proxyWebSocket(req, socket, head);
    } catch (err) {
      this.logger.error({ err }, "[CDPGateway] upgrade error");
      socket.destroy();
    }
  }

  private denySocket(socket: Duplex, code: number): void {
    const reason = code === 401 ? "Unauthorized" : "Forbidden";
    socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }
}
