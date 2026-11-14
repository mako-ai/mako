import { defineConfig } from "vitest/config";

/**
 * Apps's worktree and adversarial suites, in their OWN vitest run.
 *
 * Not folded into vitest.config.ts, and not by preference: these specs drive
 * real git and a real (local) sandbox, and running them alongside the dbt
 * suite made dbt's subprocess-cancellation specs fail on timing. A suite that
 * is heavy enough to starve its neighbours belongs in its own process.
 *
 * The E2B integration spec next to it is deliberately excluded — it needs
 * credentials and a network, so it must never join an offline run.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/apps/sharing-routes.test.ts",
      // Share links on the app's own origin: token scope, unlock, host gate.
      "src/apps/share-app-origin.test.ts",
      // Its browser half: opt-in (SHARE_ORIGIN_PLAYWRIGHT), headless.
      "src/apps/share-app-origin.browser.test.ts",
      "src/apps/worktree.service.test.ts",
      "src/apps/workspace-repo.test.ts",
      "src/apps/workspace-prompt.test.ts",
      "src/migrations/2026-09-02-110000_workspace_self_directive_to_git.test.ts",
      "src/services/skills.service.test.ts",
      "src/notebooks/notebook-git.service.test.ts",
      "src/apps/bindings.service.test.ts",
      "src/apps/env.service.test.ts",
      "src/apps/cloud-repo.service.test.ts",
      "src/apps/adversarial.test.ts",
      "src/agent-lib/tools/apps-tools-workflow-target.test.ts",
      "src/apps/git-endpoint.test.ts",
      "src/apps/workspace-consoles.service.test.ts",
      "src/apps/workspace-skills.service.test.ts",
      // Skill loads per day behind list_skills' loads30d / lastLoadedAt.
      "src/services/skill-usage.service.test.ts",
      // A hidden skill file as a failed `mako/skills` status on the commit.
      "src/apps/skill-commit-status.test.ts",
      "src/apps/box-state.service.test.ts",
      "src/apps/live-binding-guard.test.ts",
      "src/apps/binding-refresh.test.ts",
      // Phase events on the request doing the work (NDJSON), no shared state.
      "src/apps/binding-progress.test.ts",
      // The generated sandbox launcher parses, and relays build phases.
      "src/apps/dev-server-launcher.test.ts",
      // Staged binding files are replaced whole, never written in place.
      "src/apps/dev-server-staging.test.ts",
      // Asynchronous binding builds (202 + poll): job rows in real Mongo.
      "src/apps/binding-jobs.test.ts",
      "src/inngest/functions/apps-binding-concurrency.test.ts",
      // The laptop dev loop: uncommitted binding text built as a draft.
      "src/apps/binding-dev-build.test.ts",
      // Dev builds of an app not on main yet: draft-only, role-gated.
      "src/apps/unregistered-draft-app.test.ts",
      // A binding past the parquet row limit fails its build, never truncates.
      "src/apps/binding-row-limit.test.ts",
      // PARQUET_ROW_LIMIT / PARQUET_MAX_ROW_LIMIT and `-- row_limit:`.
      "src/utils/parquet-row-limit.test.ts",
      "src/apps/binding-artifact-format.test.ts",
      // Draft reuse + failure backoff: real Mongo, filesystem artifact store.
      "src/apps/binding-draft-cache.test.ts",
      // Real git + mongo: the pre-push flow-file check reads the workspace
      // repo at main and plans against live rows.
      "src/agent-lib/tools/flow-file-tools.test.ts",
      // GET/list from git at main; leftover local git without a binding
      // must not populate the list (issue #956).
      "src/services/flow-sync.repo.test.ts",
      // Flow + connector git history and restore-as-new-commit.
      "src/services/repo-entity-restore.service.test.ts",
      // The live connector probe: its service (bounded, read-only, secrets
      // scrubbed; real Mongo for tenancy) and its tool wiring/gating.
      "src/connectors/probe.service.test.ts",
      "src/agent-lib/tools/connector-tools.test.ts",
      // Source connections over MCP: plain settings and access, update,
      // delete; the app's permission rules, no secret in or out.
      "src/agent-lib/tools/connection-manage-tools.test.ts",
      "src/agent-lib/tools/apps-tools-consistency.test.ts",
      // Tool-output caps: no single result may flood the prompt.
      "src/agent-lib/tools/apps-tools-output-caps.test.ts",
      "src/agent-lib/tools/shared/output-cap.test.ts",
      "src/agent-lib/tools/shared/query-result-format.test.ts",
      "src/agent-lib/capabilities/runtime.test.ts",
      "src/apps/preview.service.test.ts",
      // The view token: an app id answered from its row, no repo resolver.
      "src/apps/view-token-route.test.ts",
      // Shared apps run CSP-sandboxed; password shares work via a URL grant.
      "src/routes/public-share-sandbox.test.ts",
      // Per-app origins: host gate, token scope, frame-ancestors, stable URLs.
      "src/apps/app-origin.test.ts",
      "src/apps/deployment.service.test.ts",
      // One store call per published asset: open + size, 404 on missing.
      "src/services/artifact-store-open-read.test.ts",
      // Viewer identity (apps.md §28): who an app is talking to, and the
      // domain auto-join that lets a link-clicker become a member.
      "src/apps/app-viewer.service.test.ts",
      // Chat with app: locked-down DuckDB over binding parquet, and who may
      // chat (the live link's audience).
      "src/apps/app-chat-query.test.ts",
      "src/apps/app-chat.service.test.ts",
      "src/services/auto-join.service.test.ts",
      "src/apps/deploy-on-push.test.ts",
      "src/apps/deploy-progress.test.ts",
      // What is live for an app: the published chip and app_publish_status.
      "src/apps/publish-state.test.ts",
      // Apps in real folders: the index over the tree at main, manifest
      // identity, moves that keep it, and the folder commits.
      "src/apps/app-index.service.test.ts",
      // The starter project, including its placeholder thumbnail.
      "src/apps/scaffold.test.ts",
      // Thumbnail variants: card-sized WebPs, cache headers, the OG cap.
      "src/apps/image-variants.test.ts",
      // Variants shared across instances via the artifact store + pre-warm.
      "src/apps/thumbnail-variants.service.test.ts",
      // GitError never carries credentials into a log line.
      "src/apps/git-redact.test.ts",
      // Link previews (Open Graph) for public shares.
      "src/services/share-og.service.test.ts",
      // Who opens which app: daily rollup, popularity score, authors.
      "src/apps/app-usage.service.test.ts",
      // The Apps home's memo: single-flight, freshness, never visibility.
      "src/apps/app-home-base.service.test.ts",
      // The Apps home feed: ranking formula, shelves, frozen-order paging.
      "src/apps/app-feed.test.ts",
      // Semantic app search: the blend with word matches (fake vectors) and
      // the document an app is embedded as, read from git.
      "src/apps/app-search-related.test.ts",
      // The refresh after a push: real git + Mongo, a fake embedding model.
      "src/apps/app-embeddings.service.test.ts",
      // Archived apps: listing archive/ from main, restore rules, grace.
      "src/apps/app-archive.test.ts",
      // Stale / unviewed apps: the planner, archive moves, the dry-run default.
      "src/apps/app-lifecycle.service.test.ts",
      "src/inngest/functions/apps-binding-refresh.test.ts",
      // One event, one build: scheduled vs after-publish, single-file read.
      "src/inngest/functions/apps-binding-refresh-event.test.ts",
      // A BigQuery result stream renews its token between pages.
      "src/services/bigquery-stream-token.test.ts",
      // The independent review of #1190: races, budget, status, refresh.
      "src/apps/review1190-bindings.test.ts",
      "src/apps/review1190-budget.test.ts",
      "src/apps/review1190-guard.test.ts",
      "src/apps/review1190-status.test.ts",
      "src/inngest/functions/review1190-refresh.test.ts",
      "src/services/review1190-token.test.ts",
      "src/apps/review1190b-cas.test.ts",
      "src/apps/review1190b-guard.test.ts",
      "src/apps/review1190b-slots.test.ts",
      "src/inngest/functions/review1190b-refresh.test.ts",
      "src/inngest/functions/apps-deploy.test.ts",
      // The hourly reconcile leaves a progressing deploy of main alone.
      "src/inngest/functions/apps-deploy-reconcile.test.ts",
      // A deploy's outcome as a GitHub commit status on the pushed sha.
      "src/apps/deploy-commit-status.test.ts",
      "src/inngest/functions/apps-deploy-status.test.ts",
      "src/services/bigquery-poll-budget.test.ts",
      // These two were written as vitest suites but listed in no vitest
      // config, so neither runner could execute them: tsx dies on them
      // with "Vitest failed to access its internal state", and vitest
      // never collected them. Invisible to both, until the coverage guard.
      // Workspace connectors: real git, real Mongo, and a real child process
      // per protocol command via the local sandbox provider.
      "src/connectors/workspace/workspace-connectors.test.ts",
      "src/connectors/workspace/resolver.test.ts",
      "src/connectors/workspace/sync-box.test.ts",
      "src/apps/repository.service.test.ts",
      "src/services/workspace-repos.service.test.ts",
      // Graceful rename (api/src/rename): the contract every kind shares, the
      // connection handler (real Mongo), and the name rules' two entry points.
      "src/rename/registry.test.ts",
      "src/rename/handlers/connection.test.ts",
      // The console handler: real git + Mongo.
      "src/rename/handlers/console.test.ts",
      "src/rename/scenarios/name-rules-parity.test.ts",
      // rename_object: kinds per surface, per-kind grants, call results.
      "src/agent-lib/tools/rename-tools.test.ts",
      // /objects/resolve and /objects/{kind}/rename: who may call them.
      "src/routes/objects.test.ts",
      // Consoles: rename and delete interleaved on purpose (real git + Mongo),
      // then the relocation service, the trash and the laptop-rename sync.
      "src/apps/console-rename-delete-race.test.ts",
      "src/apps/console-relocation.test.ts",
      // The same over HTTP: what each console route answers when refused.
      "src/routes/consoles-rename-trash.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    // Real git, real sandbox: slower than a unit test by design.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
