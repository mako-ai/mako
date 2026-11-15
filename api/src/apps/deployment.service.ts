/**
 * Apps publishing (apps.md §13.3).
 *
 * Publish = merge the branch into `main`, build from `main`, store the output
 * as an IMMUTABLE deployment keyed by commit sha, then repoint the app at it.
 *
 * Immutability is the whole design. Because every deployment keeps its own
 * prefix, rolling back is repointing `publishedSha` at an earlier sha — no
 * build, no sandbox, and no risk that "the last good version" has drifted.
 * It also means a deployment can be linked to by sha. The one thing a
 * rollback does prepare first is its DATA: a binding with no artifact is
 * built before the repoint, and a scheduled binding whose artifact predates
 * the schedule's latest occurrence is refreshed right behind it
 * (ensureDeploymentBindings), so an old sha cannot keep old numbers.
 *
 * Deployments live in the same artifact store as bindings (GCS
 * in deployed environments), so they survive API restarts and are shared
 * across instances — unlike the developer preview, whose token lives in one
 * process's memory for thirty minutes.
 *
 * Serving a deployment never touches a sandbox. That is what lets a hundred
 * viewers open an app without a hundred microVMs booting (§13.2).
 *
 * The implementation lives in `./deployment/`; this barrel keeps the import
 * path:
 *
 *   store.ts     deployment keys, the stores, uploading a build
 *   pointer.ts   the published pointer, and recording deploy failures
 *   bindings.ts  a release's data bindings: ready, current, rebuilt
 *   build.ts     building an app in the publish box, then deploying it
 *   serve.ts     reading and serving a deployment's files
 */
export {
  deploymentKey,
  legacyDeploymentKey,
  artifactStoreForRead,
  contentTypeFor,
  uploadDeployment,
} from "./deployment/store";
export type { PublishResult } from "./deployment/store";
export {
  setPublishedSha,
  clearPublishedSha,
  recordDeployFailure,
  deploymentExists,
} from "./deployment/pointer";
export {
  DEPLOYMENT_BINDING_INDEX,
  APPS_DEPLOY_INLINE_BUILD_LIMIT,
  isBindingArtifactReady,
  ensureDeploymentBindings,
} from "./deployment/bindings";
export type { DeploymentBindingReadiness } from "./deployment/bindings";
export { readDeploymentAsset, serveDeploymentFile } from "./deployment/serve";
export type { DeploymentAsset } from "./deployment/serve";
export { buildLogPath, buildApp, deployBuild } from "./deployment/build";
