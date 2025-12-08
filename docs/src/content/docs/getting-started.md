---
title: Getting Started
description: Set up Mako locally.
---

This guide will help you set up Mako on your local machine for development.

## Prerequisites

- **Node.js** (v20+)
- **pnpm** (v8+)
- **Docker** & **Docker Compose** (for MongoDB)

## Installation

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/your-org/mako.git
    cd mako
    ```

2.  **Install dependencies:**

    Mako is a monorepo managed by pnpm.

    ```bash
    pnpm install
    ```

3.  **Environment Setup:**

    Copy the example environment file to `.env`:

    ```bash
    cp .env.example .env
    ```

    Update the `.env` file with your configuration. At a minimum, you'll need:

    - `DATABASE_URL`: Your MongoDB connection string (default: `mongodb://localhost:27017/mako`)
    - `WEB_API_PORT`: Port for the API (default: `8080`)
    - `CLIENT_URL`: URL for the frontend (default: `http://localhost:5173`)

4.  **Start Infrastructure:**

    Start MongoDB using Docker:

    ```bash
    pnpm run docker:up
    ```

## Running the App

Start the development server. This will launch the API, the React App, and the Inngest dev server concurrently.

```bash
pnpm run dev
```

- **Web App**: [http://localhost:5173](http://localhost:5173)
- **API**: [http://localhost:8080](http://localhost:8080)
- **Inngest Dashboard**: [http://localhost:8288](http://localhost:8288)

## Running Flows

Mako includes a CLI for running data sync flows manually.

```bash
# Interactive mode
pnpm run sync

# Command line mode
pnpm run sync -s <source_id> -d <dest_id>
```
