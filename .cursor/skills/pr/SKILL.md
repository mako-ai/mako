---
name: pr
description: Commit, push, and open a pull request for the current changes. Invoke explicitly with /pr.
disable-model-invocation: true
---

# Create a Pull Request

## Workflow

1. **Inspect changes**: Run `git diff` to see all staged and unstaged changes. Run `git status` to see untracked files.

2. **Stage relevant files**: Add changed and new files. Skip files that shouldn't be committed (`.env`, `dist/`, `node_modules/`).

3. **Write a commit message**: Based on the actual diff, write a clear commit message:

   - Use conventional commit format: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`
   - First line: concise summary (max 72 chars)
   - Body: explain the "why", not the "what"

4. **Commit and push**:

   ```bash
   git add <files>
   git commit -m "feat: description of change"
   git push -u origin HEAD
   ```

5. **Create the PR**:

   ```bash
   gh pr create --title "feat: description" --body "$(cat <<'EOF'
   ## Summary
   - What changed and why

   ## Test plan
   - [ ] How to verify
   EOF
   )"
   ```

6. **Return the PR URL** to the user.

## Rules

- Never force push.
- Never push to `master` directly.
- Don't commit `.env`, credentials, or `dist/` files.
- If there's nothing to commit, say so and stop.
- Always run `git diff` first to understand the actual changes before writing the commit message.

## Pre-commit gate (required)

Before `git commit` / opening a PR, run full lint for every package you touched (CI is stricter than local hooks; **Prettier violations fail ESLint** as `prettier/prettier`):

| You changed files under... | Run |
| --- | --- |
| `app/` | `pnpm --filter app run lint` (and `pnpm --filter app run typecheck` if TS changed) |
| `api/` | `pnpm --filter api run lint` |

Fix all reported errors; do not push with "fix CI later" lint failures.
