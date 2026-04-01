---
title: Self-Directive
description: How the AI agent learns and remembers across conversations.
---

The self-directive is the AI agent's persistent memory within a workspace. It stores schema quirks, user preferences, learned rules, and anything the agent discovers that should be remembered across conversations.

## How It Works

Each workspace has a self-directive — a text document (up to 10,000 characters) that the agent can read and update. It persists across all chat sessions in that workspace.

When the agent starts a conversation, it can read the self-directive to recall what it learned before. When it discovers something new — like a column naming convention, a data type gotcha, or a user preference — it writes it to the self-directive.

## Tools

| Tool                    | Operation          | Purpose                         |
| ----------------------- | ------------------ | ------------------------------- |
| `read_self_directive`   | —                  | Read the current self-directive |
| `update_self_directive` | `set`              | Overwrite the entire directive  |
|                         | `append`           | Add content to the end          |
|                         | `prepend`          | Add content to the beginning    |
|                         | `find_and_replace` | Replace a specific section      |
|                         | `insert_after`     | Insert content after a marker   |
|                         | `delete_section`   | Remove a section                |

## What Gets Stored

Typical self-directive content:

- **Schema notes**: "The `users` table stores `created_at` as Unix timestamp (seconds), not ISO date"
- **Naming conventions**: "This workspace uses `snake_case` for all table names"
- **Query patterns**: "Always filter by `workspace_id` when querying the `events` table"
- **User preferences**: "User prefers CTEs over subqueries"
- **Data quirks**: "The `amount` column in `charges` is in cents, divide by 100 for display"

## The Agent's Memory Loop

1. Agent encounters a new schema → inspects it → discovers a quirk
2. Agent checks self-directive for existing notes about this schema
3. Agent saves the quirk using `update_self_directive`
4. Next conversation, agent reads self-directive → already knows the quirk → skips re-discovery

This means the agent gets faster and more accurate over time for recurring work in the same workspace.
