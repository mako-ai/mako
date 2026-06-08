# Agent Skills (system skills)

Filesystem-backed, git-versioned **Agent Skills** that the AI agents load on
demand (progressive disclosure) instead of carrying in the base system prompt.
This keeps the always-on prompt lean: the skill _catalog_ (name + description)
is always injected, but the heavy bodies and reference material load only when
relevant.

These are **system skills** — static, shipped-with-the-code reference material.
They are distinct from **workspace skills** (Mongo-backed, learned per-workspace
memory in `api/src/services/skills.service.ts`). Both flow through the same
retrieval/injection pipeline and the same `load_skill` / `read_skill_resource`
tools.

## Directory layout

```
api/src/agent-skills/
  <skill-name>/
    SKILL.md            # frontmatter + body (tier 1 + tier 2)
    references/         # optional tier-3 deep material
      <topic>.md
```

## SKILL.md format

```markdown
---
name: dialect-clickhouse
description: Writing or debugging ClickHouse SQL — ... (this is the trigger)
entities:                # optional; unioned with auto-extracted tokens
  - clickhouse
  - sql
---

# Body in markdown

The compact, high-signal guidance the agent needs once this skill fires.
```

- **`name`** — stable identifier (matches the directory name). Used as the
  `load_skill` argument and shown in the catalog.
- **`description`** — the **retrieval trigger**: "when to load this skill".
  Write it as a condition/task, not a summary. This is the primary signal the
  retriever scores against, so include the words a user would use.
- **`entities`** (optional) — extra tokens for entity-overlap scoring
  (database names, function names, synonyms). Unioned with tokens auto-extracted
  from the name + description.

## Progressive disclosure tiers

1. **Tier 1 — catalog**: `name` + `description`, always injected.
2. **Tier 2 — body**: the `SKILL.md` markdown, auto-injected when the skill
   scores above threshold for the turn, or pulled with `load_skill(name)`.
3. **Tier 3 — references**: `references/*.md`, never auto-injected. Pulled with
   `read_skill_resource(name, "references/<file>.md")`. Point at them from the
   body so the agent knows what exists.

## Size budget & rules

- Keep the `SKILL.md` **body under ~500 lines**. If it grows past that, move the
  long-form material into `references/` and leave a one-line pointer.
- **No duplication** between the body and references — each fact lives in one
  place.
- **One skill per capability.** Don't bundle unrelated topics.
- Any new vendor/database/app/domain guidance goes here, **never** into the base
  agent prompt. See `.cursor/rules/35-agent-prompts.mdc`.

## How discovery works

At first access (and cached thereafter), `discoverSystemSkills()` in
`api/src/agent-lib/skills/system-skills.ts` scans this directory, parses each
`SKILL.md` frontmatter via `js-yaml`, and registers the skill in an in-memory
registry. The directory is resolved relative to the compiled module, so it works
under both `tsx` (`src/agent-skills`) and `node` (`dist/agent-skills`). The
build copies `*.md` into `dist` (`copyfiles` step in `api/package.json`).

## Dynamic bodies (templates)

A skill body may contain `{{PLACEHOLDER}}` tokens substituted at read time. A
module registers a provider via `registerSystemSkillTemplate(name, () => ({...}))`.
The `flows` skill uses this to inject auto-generated form-field docs from the
unified schema so they never drift. Register the provider at module load,
before the skill is read.

## Adding a new skill

1. Create `api/src/agent-skills/<name>/SKILL.md` with `name` + `description`
   frontmatter and a concise body.
2. Add `references/*.md` for anything long, and point at them from the body.
3. (Optional) declare `entities` to sharpen retrieval.
4. That's it — discovery is automatic at boot. Verify with the boot log
   ("Discovered system skills") and a chat that should trigger it.
