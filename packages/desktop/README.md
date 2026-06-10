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

### Auto-update

Installed apps update themselves via `electron-updater`:

- The packaged app embeds a generic update feed pointing at
  `https://github.com/mako-ai/mako/releases/latest/download` (see `publish`
  in `electron-builder.yml`). Stable asset names make the feed evergreen, so
  no tag parsing is involved — but it also means the repo's "latest"
  (non-prerelease) release must always be a desktop release.
- The release workflow uploads `latest*.yml`, the mac `.zip` archives (what
  macOS auto-update actually downloads; the `.dmg` is for first installs)
  and `*.blockmap` files (differential downloads) next to the installers.
- Updates download in the background on launch and every 6 hours, then apply
  on restart (or immediately via the "Restart Now" prompt).
- **macOS requires a Developer ID–signed build to self-update** — Squirrel.Mac
  rejects ad-hoc signatures. Until the signing secrets below are configured,
  macOS users get a dialog pointing at the download page instead. Windows
  (NSIS) and Linux (AppImage) self-update fine unsigned.
- Installs older than the first auto-updating release have no updater and
  need one final manual download.

### Code signing & notarization (macOS)

Signing turns on automatically in `release-desktop.yml` once these GitHub
repo secrets exist (Settings → Secrets and variables → Actions):

| Secret | What it is |
| --- | --- |
| `MAC_CSC_LINK` | base64 of the Developer ID Application `.p12` |
| `MAC_CSC_KEY_PASSWORD` | password chosen when exporting the `.p12` |
| `APPLE_ID` | Apple ID email of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password from account.apple.com |
| `APPLE_TEAM_ID` | 10-char team id (developer.apple.com → Membership) |

How to obtain them:

1. Enroll in the Apple Developer Program ($99/yr) at
   developer.apple.com/programs — as a company you'll need a D-U-N-S number.
2. Create a **Developer ID Application** certificate: Xcode → Settings →
   Accounts → Manage Certificates → "+" (or developer.apple.com →
   Certificates with a CSR from Keychain Access).
3. Export it from Keychain Access as `.p12` with a password, then
   `base64 -i certificate.p12 | pbcopy` → `MAC_CSC_LINK`.
4. Create an app-specific password at account.apple.com → Sign-In and
   Security → App-Specific Passwords → `APPLE_APP_SPECIFIC_PASSWORD`.

With the first two secrets builds are signed; with all five they are also
**notarized** (hardened runtime + `build/entitlements.mac.plist` are already
configured), which removes all Gatekeeper friction. Until then, CI ad-hoc
signs (`scripts/after-pack.js`) and users must allow the app via System
Settings → Privacy & Security → Open Anyway, or
`xattr -dr com.apple.quarantine /Applications/Mako.app`.

Windows Authenticode signing (optional, removes SmartScreen warnings):
`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`, same pattern.

### Homebrew

The release workflow auto-publishes a cask to `mako-ai/homebrew-tap`
(template: `homebrew/mako.rb.tmpl`) when the `HOMEBREW_TAP_TOKEN` secret is
configured. Setup once:

1. Create a public repo `mako-ai/homebrew-tap`.
2. Create a fine-grained PAT with `contents: write` on that repo →
   secret `HOMEBREW_TAP_TOKEN`.

Users then install with `brew install --cask mako-ai/tap/mako`. Submission
to the official `homebrew/cask` repo is possible later once the app is
notarized and has traction (their reviewers check project notability).

### Mac App Store (optional, not wired up)

MAS distribution is a separate target (`mas`) with different signing
("Apple Distribution" cert + provisioning profile) and requires the App
Sandbox entitlements, an App Store Connect app record, and review. The
bundled Local Agent gives the app the "native functionality" App Review
expects from guideline 4.2 (no bare web wrappers). Recommended only after
Developer ID + Homebrew distribution is established.

## Sign-in (browser handoff via `mako://`)

Third-party logins (Google/GitHub) never render inside the shell — the user
couldn't verify the domain or certificate there, and the fresh Chromium
profile has no password manager. Instead:

1. The login screen (web app detects `window.makoDesktop`) asks the main
   process to start browser auth. The main process generates a PKCE pair —
   the **verifier** stays in memory, the **challenge** goes into
   `{APP_URL}/desktop-auth?challenge=...`, opened in the **system browser**.
2. The user signs in there with any method (or is already signed in). The
   page mints a one-time, 60-second auth code bound to the challenge
   (`POST /api/auth/desktop/code`) and triggers `mako://auth?code=...`
   ("Open Mako" button).
3. The OS delivers the deep link (`open-url` on macOS; second-instance /
   cold-start argv on Windows/Linux — the single-instance lock handles
   focus). The shell loads
   `{APP_URL}/api/auth/desktop/complete?code=...&verifier=...` in the main
   window; the server verifies code + PKCE, sets the session cookie, and
   redirects into the app.

A `will-navigate` guard additionally rewrites any in-window navigation to
`/api/auth/google|github` (e.g. from a stale cached frontend) into the same
browser handoff.

The `mako://` scheme is declared in `electron-builder.yml` (`protocols`),
which covers macOS `CFBundleURLTypes`, Windows NSIS registry entries, and
the Linux `.desktop` entry's `x-scheme-handler/mako` MimeType.
`app.setAsDefaultProtocolClient` keeps dev runs working; note that protocol
registration from non-packaged Linux dev shells is best-effort. To exercise
the final hop manually in dev, paste the
`/api/auth/desktop/complete?code=...&verifier=...` URL produced by the flow
into the window via `MAKO_DESKTOP_URL`.

The shell also strips the `Electron/x.y` token from the user agent so the
web app sees a regular Chrome UA.
