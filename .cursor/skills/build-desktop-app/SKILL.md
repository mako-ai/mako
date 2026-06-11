---
name: build-desktop-app
description: Build, test, package, and release Mako Desktop and the Mako Local Agent. Use when changing packages/desktop, packages/local-agent, shipping a new desktop version, or debugging the desktop release pipeline.
---

# Build & release Mako Desktop

## Components

| Piece | Path | Output |
| --- | --- | --- |
| Local Agent | `packages/local-agent` | `dist/index.js` (single-file bundle, plain node) |
| Desktop shell | `packages/desktop` | `release/*` (dmg/exe/AppImage via electron-builder) |
| Release pipeline | `.github/workflows/release-desktop.yml` | GitHub Release `desktop-vX.Y.Z` |
| PR smoke build | `.github/workflows/desktop-ci.yml` | build-only |
| Website links | `website/lib/downloads.ts`, `website/app/download` | evergreen download page |

## Local development

```bash
pnpm agent:dev                                       # agent on 127.0.0.1:41720
MAKO_DESKTOP_URL=http://localhost:5173 pnpm desktop:dev   # shell against dev stack
```

The shell skips spawning the agent if one is already listening (or set
`MAKO_AGENT_SPAWN=0`).

## Verify a change end-to-end

1. Typecheck both packages: `pnpm --filter @mako/local-agent typecheck && pnpm --filter @mako/desktop typecheck`
2. Smoke the agent API:
   `curl http://127.0.0.1:41720/health`, then `/test-connection` and `/execute`
   against a local Postgres/Mongo.
3. Bundle and re-run under plain node (catches esbuild + native-module
   regressions): `pnpm --filter @mako/local-agent build && node packages/local-agent/dist/index.js`
4. Package unpacked and launch:
   `pnpm --filter @mako/desktop pack:dir && packages/desktop/release/linux-unpacked/mako`
   (use `ELECTRON_DISABLE_SANDBOX=1` and `DISPLAY=:1` in headless VMs).
   Verify the packaged app spawned the bundled agent: `curl http://127.0.0.1:41720/health`.

## Ship a release

1. Bump `version` in `packages/desktop/package.json` (semver) in the PR.
2. Merge to master. `release-desktop.yml` builds macOS arm64+x64, Windows
   x64, Linux x64 and creates tag + GitHub Release `desktop-vX.Y.Z`.
3. No version bump → no release (the workflow checks for an existing release
   and skips). Re-run manually with workflow_dispatch `force` to re-upload.
4. Evergreen links (used by the website) — do not rename artifacts:
   `https://github.com/mako-ai/mako/releases/latest/download/Mako-{mac-arm64.dmg,mac-x64.dmg,win-x64.exe,linux-x86_64.AppImage}`

## Gotchas

- New agent dependencies must be pure-JS or have a JS fallback; add optional
  native modules to `OPTIONAL_STUBS` in `packages/local-agent/build.mjs`.
- `onlyBuiltDependencies` in `pnpm-workspace.yaml` must include `electron`
  or its binary won't download; the server `Dockerfile` sets
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1` to keep images lean.
- macOS/Windows builds are unsigned until signing secrets are configured —
  see `packages/desktop/README.md` for the secret names.
- electron-builder maps `${arch}` to `x86_64` for AppImage names.
