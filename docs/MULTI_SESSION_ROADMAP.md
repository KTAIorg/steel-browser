# Multi-Session Roadmap (KT fork)

Status: design note — not implemented. The fork currently keeps upstream's
single-active-session-per-container model (1 container = 1 Chrome process = 1
session), and KT scales horizontally by replicating containers.

## Why not now

Upstream's `SessionService` tracks a single `activeSession`
(`api/src/services/session.service.ts`), and `CDPService` holds a single
`browserInstance` / `primaryPage` / `wsEndpoint` / `launchConfig` / fingerprint
state (`api/src/services/cdp/cdp.service.ts`). Making these per-session maps
touches:

- browser lifecycle: `endSession()` shuts the whole Chrome process down and
  relaunches the idle default browser; per-session teardown needs browser
  contexts or child processes instead;
- target routing: `targetcreated`/`targetchanged` handlers, instrumentation
  attach, and the CDP websocket proxy assume one browser endpoint;
- fingerprint/proxy/userDataDir state: currently a single mutable
  `fingerprintData` + one proxy server per session slot.

Estimated > 300 lines with behavioral risk on the CDP restart semantics, so per
KT policy this lands as a roadmap instead of a rushed patch.

## Target design (when needed)

1. One Chrome process per container stays; sessions become Puppeteer
   **browser contexts** (`browser.createBrowserContext()`), which give each
   session isolated cookies/storage/incognito-like state without extra
   processes.
2. `SessionService` keeps `Map<sessionId, Session>`; `CDPService` gains
   `Map<contextId, ContextState>` for fingerprint, proxy binding and target
   registry. `/json/list` filtering in `CDPGateway` switches from
   "all pages of the browser" to "pages of the requesting session's context",
   keyed by the CDP token or a per-session ticket.
3. `endSession(sessionId)` closes only that context; the browser-level restart
   remains only for the idle default.
4. Caveat to verify before shipping: contexts share the process-level hardware
   fingerprint (GPU renderer, fonts) and one proxy chain per launch unless
   per-context proxies are wired; KT's anti-correlation budget
   (`MAX_CONTEXTS_PER_INSTANCE`) must be attested empirically before raising it
   above 1.

## Interim scaling guidance

Scale by container replicas (K8s Deployment `replicas: N`, one session per
replica). The control plane (`kt-agent-browser` steel driver) allocates
sessions to replicas; see the fork README for the `MAX_CONTEXTS_PER_INSTANCE`
semantics under this fork (fixed at 1).
