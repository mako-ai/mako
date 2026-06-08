# Agent system skills

System skills are git-versioned `SKILL.md` packages loaded through the same
progressive-disclosure pipeline as workspace skills. They hold durable,
reviewable reference material that should not live in base agent prompts.

## Package layout

```text
api/src/agent-skills/
  <skill-name>/
    SKILL.md
    references/
      optional-long-reference.md
```

`SKILL.md` must start with YAML frontmatter:

```md
---
name: dialect-postgresql
description: Load when writing or debugging PostgreSQL SQL queries.
---

# PostgreSQL SQL dialect

...
```

- `name` is the stable identifier used by `load_skill(name)`.
- `description` is the retrieval trigger. Write it as a sentence describing
  when the skill should load.
- The body should stay focused and generally remain under about 500 lines.
- Long examples, vendor manuals, chart specifications, and debugging playbooks
  belong in `references/*.md`.

## Discovery and build

`api/src/agent-lib/skills/system-skills.ts` discovers every
`api/src/agent-skills/*/SKILL.md` package at API boot and lazily when prompt
modules are imported. The API build copies markdown files into `dist` so the
same relative lookup works under both `tsx src/index.ts` and `node dist/index.js`.

## Retrieval behavior

System skills are always shown in the skills catalog with a `[system]` tag.
Their bodies are auto-injected only when the current user request overlaps the
skill trigger strongly enough, or when the agent explicitly calls
`load_skill(name)`. Dashboard references are tier-3 material: the agent should
call `read_skill_resource(name, "references/file.md")` only when the core skill
points to a needed detail.

## Authoring rules

1. Keep base prompts lean. Put vendor, database, dashboard, flow, connector, or
   domain guidance here instead of in `api/src/agent-lib/prompts/**` or
   `api/src/agents/**/prompt.ts`.
2. Use one skill per capability or vendor dialect.
3. Keep `description` short and trigger-oriented.
4. Do not duplicate long material between `SKILL.md` and `references/`.
5. Prefer concise tables and executable examples over prose.
6. When adding references, use relative markdown links or list the exact
   `read_skill_resource` path in the body.
