import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, writeFile, mkdir } from "fs/promises";
import os from "os";
import path from "path";
import { SessionService } from "./session.service.js";
import { CDPService } from "./cdp/cdp.service.js";
import { SeleniumService } from "./selenium.service.js";
import { FileService } from "./file.service.js";
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

function buildSessionService() {
  const cdpService = new CDPService({}, noopLogger);
  const seleniumService = new SeleniumService(noopLogger);
  const fileService = new FileService({
    baseFilesPath: path.join(os.tmpdir(), "steel-session-test-files"),
    prebuiltArchiveDir: path.join(os.tmpdir(), "steel-session-test-archive"),
    watchFiles: false,
  });
  const sessionService = new SessionService({
    cdpService,
    seleniumService,
    fileService,
    logger: noopLogger,
  });
  sessionService.setProxyFactory(() => {
    throw new Error("proxy not expected in this test");
  });
  return sessionService;
}

describe("userDataDir precedence", () => {
  it("keeps the caller-provided userDataDir instead of overriding it with the built-in persist path", async () => {
    const svc = buildSessionService();
    const observed: string[] = [];
    svc["cdpService"].startNewSession = async (config) => {
      observed.push(String(config.userDataDir));
      return undefined as unknown as Awaited<ReturnType<CDPService["startNewSession"]>>;
    };

    const customDir = await mkdtemp(path.join(os.tmpdir(), "steel-udd-test-"));
    await mkdir(path.join(customDir, "inner"), { recursive: true });
    await writeFile(path.join(customDir, "inner", "marker.txt"), "kt");

    await svc.startSession({
      persist: true,
      userDataDir: customDir,
      credentials: {},
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]).toBe(customDir);

    // The directory is real and usable by Chrome (already existed, marker intact).
    expect(await readdir(path.join(customDir, "inner"))).toContain("marker.txt");
  });

  it("falls back to the built-in persist directory when only persist=true is given", async () => {
    const svc = buildSessionService();
    const observed: string[] = [];
    svc["cdpService"].startNewSession = async (config) => {
      observed.push(String(config.userDataDir));
      return undefined as unknown as Awaited<ReturnType<CDPService["startNewSession"]>>;
    };

    await svc.startSession({ persist: true, credentials: {} });

    expect(observed).toHaveLength(1);
    expect(observed[0]).not.toContain("steel-chrome");
    expect(observed[0].endsWith(path.join("api", "user-data-dir"))).toBe(true);
  });
});
