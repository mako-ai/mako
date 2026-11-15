/**
 * Apps live dev preview — `vite dev` INSIDE the sandbox (apps.md §12.4).
 *
 * The previous implementation spawned vite as a child process of the API host
 * and proxied to it. That could only ever work under the deleted local sandbox
 * provider, because it is exactly what N1 forbids: tenant code executing in the
 * API process. So the throwaway dev substrate had live preview and every real
 * environment had none.
 *
 * Now the dev server runs where the app's files already are. E2B exposes a
 * per-sandbox public origin for any port (`https://<port>-<sandboxId>.e2b.app`),
 * which the browser loads directly — no Mako proxy, no WebSocket relay of our
 * own (HMR rides that same origin), and nothing of the tenant's on our host.
 *
 * Two details the sandbox forces, both handled here rather than in the app's
 * own files:
 *
 * - Vite must bind `0.0.0.0`, and since 5.4 it rejects requests whose Host it
 *   does not recognise — the E2B origin is exactly such a Host. Both are server
 *   options, and we set them through Vite's JS API so they take precedence over
 *   whatever the app's `vite.config.ts` says WITHOUT editing a file the user
 *   owns and commits.
 * - The sandbox's idle timeout would pause the microVM out from under a dev
 *   server that is running but momentarily idle, so it is pushed out explicitly.
 *
 * The implementation lives in `./dev-server/`; this barrel keeps the import
 * path:
 *
 *   paths.ts     where a dev session lives in the box (ports, sockets, logs)
 *   launcher.ts  the generated launcher script vite runs under
 *   staging.ts   staging binding data into the box, atomically
 *   status.ts    is it serving, discovery, the running cap
 *   launch.ts    ensureDevServer: single-flight launch and reattach
 */
export { devLogPath, devConsolePath, currentDevPort } from "./dev-server/paths";
export { launcherSource } from "./dev-server/launcher";
export { stageFileAtomically } from "./dev-server/staging";
export {
  isServingApp,
  discoverDevServers,
  devServerStatus,
} from "./dev-server/status";
export { releaseDevServerSlot, ensureDevServer } from "./dev-server/launch";
export type { DevPreview } from "./dev-server/launch";
