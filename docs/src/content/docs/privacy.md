---
title: Privacy Policy
description: How Mako collects, stores, and uses data — including Slack and other MCP connections.
---

# Privacy Policy

**Effective date:** July 14, 2026  
**Controller:** Mako (the open-source project and hosted service at [app.mako.ai](https://app.mako.ai))  
**Contact:** See [Support](/support/)

This policy describes how the **hosted** Mako service (`app.mako.ai`) handles personal data. If you **self-host** Mako, you are the controller for your deployment; this document still describes what the software stores so you can write your own policy.

## What Mako is

Mako is an AI-native data platform (SQL client, connectors, dashboards, apps, and an agent). You connect databases and optional third-party tools; the agent helps you query and act with your permission.

## Data we collect

### Account

- Email address, name (if provided), authentication identifiers (e.g. Google/GitHub OAuth subject)
- Password hash (if you use email/password) — we never store plaintext passwords
- Workspace membership and role

### Workspace content you create

- Saved queries, consoles, dashboards, apps, flows, agent chats, skills, and settings you store in Mako
- Database connection metadata and **encrypted** credentials you choose to save

### Slack and other MCP connections

When you connect Slack (or another MCP server):

- We store an **encrypted** OAuth client configuration (when applicable) and **encrypted** per-user access/refresh tokens
- We may cache the server's discovered **tool list** (names/descriptions), not your Slack message archive
- When the agent uses a Slack tool, the request goes to Slack's official MCP endpoint (`mcp.slack.com`) using **your** token; message content may briefly transit our API to render results in chat and may appear in chat history you keep in Mako

We do **not**:

- Sell Slack data
- Use Slack workspace content to **train** foundation models
- Share Slack contents with other Mako customers

### Usage and operations

- Application logs (errors, auth events, sync/job metadata) needed to run and secure the service
- Optional product analytics if enabled for the deployment

## How we use data

- Provide the product you signed up for (auth, workspaces, agent, syncs, UI)
- Call third-party APIs **you** connected, on your behalf
- Secure the service (abuse prevention, incident response)
- Communicate about the account (security notices, essential product email)

## Legal bases (EEA/UK)

Where GDPR/UK GDPR applies: contract performance, legitimate interests (security, product improvement that does not override your rights), and consent where required (e.g. certain cookies or optional analytics).

## Sharing

We share data only with:

- **Infrastructure processors** that host or operate the service (e.g. cloud hosting, email delivery, AI inference gateways) under contractual safeguards
- **Third-party services you connect** (Slack, Close, databases, etc.) — as necessary to fulfill your requests
- Authorities when legally required

We do not sell personal data.

## Retention

- Account and workspace data: until you delete the workspace/account, or after a reasonable inactivity period for abandoned accounts
- OAuth tokens: until you disconnect the integration or delete the account; rotating Slack app credentials invalidates stored member tokens
- Backups: retained for a limited operational window, then deleted

## Security

- Credentials and OAuth tokens encrypted at rest (AES-256-CBC) with a deployment encryption key
- Access scoped to your workspace membership
- Transport over HTTPS in production

No method of transmission or storage is 100% secure; we work to protect data with industry-standard practices.

## Your rights

Depending on your location, you may request access, correction, deletion, export, or restriction of processing. Contact us via [Support](/support/). You can also:

- Disconnect Slack / MCP servers in **Settings → MCP Servers**
- Delete workspace resources you own
- Close your account by contacting support

## Children

Mako is not directed at children under 16, and we do not knowingly collect their data.

## International transfers

Hosted infrastructure may process data in the United States or other regions. Where required, we use appropriate transfer mechanisms.

## Changes

We may update this policy. Material changes will be reflected by updating the effective date on this page.

## Slack-specific summary (Marketplace)

| Topic | Practice |
| --- | --- |
| Tokens | Encrypted at rest; per-user; used only to call Slack MCP |
| Training | Slack data is **not** used to train LLMs |
| Scopes | Requested to match the write tier you select in Mako |
| Revocation | Disconnect in Mako or revoke the app in Slack |
| Subprocessors | Cloud host + AI gateway process prompts/tool results you generate in Mako |
