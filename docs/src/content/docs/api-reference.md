---
title: API Reference
description: Key API endpoints in Mako.
---

The Mako API is a RESTful API built with Hono. All endpoints are prefixed with `/api`.

## Authentication

| Method | Endpoint             | Description               |
| :----- | :------------------- | :------------------------ |
| `POST` | `/api/auth/login`    | Login with email/password |
| `POST` | `/api/auth/register` | Create a new account      |
| `GET`  | `/api/auth/me`       | Get current user session  |
| `POST` | `/api/auth/logout`   | End session               |

## Workspaces

| Method | Endpoint              | Description           |
| :----- | :-------------------- | :-------------------- |
| `GET`  | `/api/workspaces`     | List user workspaces  |
| `POST` | `/api/workspaces`     | Create a workspace    |
| `GET`  | `/api/workspaces/:id` | Get workspace details |

## Connectors & Sync

| Method | Endpoint                              | Description                  |
| :----- | :------------------------------------ | :--------------------------- |
| `GET`  | `/api/workspaces/:wid/connectors`     | List configured data sources |
| `POST` | `/api/workspaces/:wid/connectors`     | Add a new data source        |
| `POST` | `/api/workspaces/:wid/sync-jobs`      | Trigger a sync job           |
| `GET`  | `/api/workspaces/:wid/sync-jobs/:jid` | Get sync job status          |

## Query Execution

| Method | Endpoint       | Description                 |
| :----- | :------------- | :-------------------------- |
| `POST` | `/api/execute` | Execute a SQL/NoSQL query   |
| `POST` | `/api/agent`   | Ask the AI agent a question |

## Inngest

| Method | Endpoint       | Description             |
| :----- | :------------- | :---------------------- |
| `POST` | `/api/inngest` | Inngest webhook handler |
