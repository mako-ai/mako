# Mako Desktop

A thin Electron shell around the Mako web app (Figma/Notion/Slack model):

- The window loads the **live web app** (`https://app.mako.ai` by default),
  so the product self-updates with every cloud deploy. This binary rarely
  changes.
- The **Mako Local Agent** (`packages/local-agent`) is bundled and started
  alongside, so connections to databases on this machine (localhost Postgres,
  Mongo, etc.) work out of the box.

## Develop

```bash
pnpm desktop:dev                                  # loads https://app.mako.ai
MAKO_DESKTOP_URL=http://localhost:5173 pnpm desktop:dev   # against local dev
MAKO_AGENT_SPAWN=0 pnpm desktop:dev               # don't spawn the agent
```

In dev the agent is spawned via `pnpm --filter @mako/local-agent start`. If
an agent is already running on the port, the shell detects it and skips
spawning.

## Package

```bash
pnpm --filter @mako/desktop pack:dir   # unpacked build (fast smoke test)
pnpm --filter @mako/desktop dist       # installers for the current OS
```

Packaging bundles the standalone agent (built by
`pnpm --filter @mako/local-agent build`) into `resources/agent/index.js`;
the main process spawns it with `ELECTRON_RUN_AS_NODE`.

## Release & distribution

Releases are automated by `.github/workflows/release-desktop.yml`:

1. Bump `version` in `packages/desktop/package.json` in your PR.
2. Merge to `master`. The workflow builds macOS (arm64 + x64), Windows (x64),
   and Linux (x64), then creates the `desktop-vX.Y.Z` tag and GitHub Release.
3. Asset names are stable, so these links always serve the latest release:
   - `https://github.com/mako-ai/mako/releases/latest/download/Mako-mac-arm64.dmg`
   - `https://github.com/mako-ai/mako/releases/latest/download/Mako-mac-x64.dmg`
   - `https://github.com/mako-ai/mako/releases/latest/download/Mako-win-x64.exe`
   - `https://github.com/mako-ai/mako/releases/latest/download/Mako-linux-x86_64.AppImage`

The website download page (`website/app/download`) auto-detects the visitor's
platform and points at these evergreen links.

### Code signing (TODO before public distribution)

Builds are currently unsigned. Configure these repo secrets and uncomment the
env lines in the release workflow:

- macOS: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` (Developer ID `.p12`), plus
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization.
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` (Authenticode).

Unsigned macOS builds require right-click → Open (or
`xattr -dr com.apple.quarantine /Applications/Mako.app`) on first launch.
Signing is also a prerequisite for auto-update (electron-updater) later.

## OAuth note

The shell strips the `Electron/x.y` token from the user agent so Google
OAuth works in-window. If providers tighten embedded-browser detection, the
fallback plan is system-browser OAuth with a `mako://` deep-link callback.
