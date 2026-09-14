import { FastifyPluginAsync } from "fastify";
import { CDPService } from "../services/cdp/cdp.service.js";
import { CDPGateway, resolveCDPGatewayBindPolicy } from "../services/cdp-gateway.service.js";
import fp from "fastify-plugin";
import { BrowserLauncherOptions } from "../types/index.js";
import {
  DuckDBStorage,
  InMemoryStorage,
  LogStorage,
} from "../services/cdp/instrumentation/storage/index.js";
import path from "path";
import os from "os";
import { env } from "../env.js";

declare module "fastify" {
  interface FastifyInstance {
    cdpService: CDPService;
    registerCDPLaunchHook: (hook: (config: BrowserLauncherOptions) => Promise<void> | void) => void;
    registerCDPShutdownHook: (
      hook: (config: BrowserLauncherOptions | null) => Promise<void> | void,
    ) => void;
  }
}

const browserInstancePlugin: FastifyPluginAsync = async (fastify, _options) => {
  // Fail fast, before Fastify binds the HTTP port. An error thrown from an
  // onListen hook is only logged (Fastify resolves listen() before running the
  // hooks), which would leave the API serving traffic with the CDP gateway
  // silently missing; throwing here rejects listen() and exits non-zero via
  // src/index.ts instead.
  resolveCDPGatewayBindPolicy(env.HOST ?? "0.0.0.0");

  const loggingConfig = fastify.steelBrowserConfig?.logging || {};
  const enableStorage = loggingConfig.enableStorage ?? env.LOG_STORAGE_ENABLED ?? false;
  const enableConsoleLogging = loggingConfig.enableConsoleLogging ?? true;

  let storage: LogStorage | null = null;
  if (enableStorage) {
    const storagePath =
      loggingConfig.storagePath ||
      env.LOG_STORAGE_PATH ||
      path.join(os.tmpdir(), "steel-browser-logs", "logs.duckdb");

    storage = new DuckDBStorage({
      dbPath: storagePath,
      maxThreads: 1,
      memoryLimit: "128MB",
      parquetCompression: "none",
      enableWriteBuffer: true,
      writeBufferSize: 200,
      writeBufferFlushInterval: 2000,
    });

    await storage.initialize();
    fastify.log.info(`Log storage initialized at ${storagePath}`);
  } else {
    // Use in-memory storage for development
    storage = new InMemoryStorage(1000);
    await storage.initialize();
    fastify.log.info("Using in-memory log storage");
  }

  const cdpService = new CDPService({}, fastify.log, storage, enableConsoleLogging);

  fastify.decorate("cdpService", cdpService);
  fastify.decorate(
    "registerCDPLaunchHook",
    (hook: (config: BrowserLauncherOptions) => Promise<void> | void) => {
      cdpService.registerLaunchHook(hook);
    },
  );
  fastify.decorate(
    "registerCDPShutdownHook",
    (hook: (config: BrowserLauncherOptions | null) => Promise<void> | void) => {
      cdpService.registerShutdownHook(hook);
    },
  );

  fastify.addHook("onListen", async function () {
    this.log.info("Launching default browser...");
    await cdpService.launch();

    // Serve the public CDP surface through the session-scoped gateway instead
    // of nginx passthrough, so /json/list cannot enumerate other sessions'
    // targets. The gateway fails closed: without CDP_TOKEN it refuses to start
    // unless CDP_ALLOW_ANONYMOUS=true pins it to loopback.
    const gateway = new CDPGateway({ cdpService, logger: this.log });
    const cdpPort = parseInt(env.CDP_REDIRECT_PORT, 10) || 9222;
    try {
      await gateway.listen(cdpPort, env.HOST ?? "0.0.0.0");
      this.log.info(
        `CDP gateway listening on port ${cdpPort} (token ${
          env.CDP_TOKEN ? "required" : "not set - loopback only via CDP_ALLOW_ANONYMOUS"
        })`,
      );
    } catch (err) {
      this.log.error({ err }, "Failed to start CDP gateway");
      throw err;
    }
    // The Fastify instance is already listening when onListen fires, so an
    // onClose hook cannot be registered at this point; tie gateway shutdown to
    // process signals instead.
    const shutdown = () => void gateway.close();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
};

export default fp(browserInstancePlugin, "5.x");
