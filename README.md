<h1 align="center">
  <img src="./app/public/mako-icon.svg" alt="Mako Logo" width="40" height="35" style="vertical-align: middle; margin-right: 10px;">
  Mako
</h1>

<p align="center"><strong>The AI-native SQL Client.</strong></p>

> **The Cursor for Data.** Connect to any database and query with AI assistance.

Stop wrestling with complex SQL and slow, bloated database tools. Write queries in plain English and get instant, accurate results.

![Mako App Interface](./website/public/app-screenshot.png)

## 🚀 Why Mako?

A modern SQL client built for the AI era, replacing slow desktop tools with a fast, collaborative, AI-powered experience.

- **✨ AI Query Generation**: Write queries in natural language. Our schema-aware AI generates optimized SQL instantly.
  - _Replaces: DataGrip, DBeaver, Postico_
- **👥 Team Collaboration**: Share connections, version-control queries, and work together in real-time.
  - _Replaces: Passing credentials around, lost SQL files_
- **⚡ Blazing Fast**: No Java or Electron bloat. Opens instantly in your browser and runs smooth.
  - _Replaces: Slow desktop database tools_

## 🔌 Integrations

Connect your favorite tools and platforms.

### Databases

| Integration    | Status  | Description                                         |
| -------------- | ------- | --------------------------------------------------- |
| **PostgreSQL** | ✅ Live | Connect to PostgreSQL for relational data queries   |
| **MongoDB**    | ✅ Live | Connect to MongoDB for flexible document-based data |
| **BigQuery**   | ✅ Live | Analyze large datasets with Google BigQuery         |
| **MySQL**      | 🚧 Soon | Query MySQL databases with natural language         |
| **Snowflake**  | 🚧 Soon | Query Snowflake databases with natural language     |
| **Databricks** | 🚧 Soon | Query Databricks databases with natural language    |

### Connectors

| Integration               | Status  | Description                                      |
| ------------------------- | ------- | ------------------------------------------------ |
| **Stripe**                | ✅ Live | Track payments, subscriptions, and billing data  |
| **PostHog**               | ✅ Live | Analyze product analytics and user behavior      |
| **Google Analytics**      | ✅ Live | Connect website traffic and conversion data      |
| **Google Search Console** | ✅ Live | Connect Google Search Console data               |
| **Close.com**             | ✅ Live | Sync CRM data (leads, opportunities, activities) |
| **GraphQL**               | ✅ Live | Query any GraphQL API with custom endpoints      |
| **REST**                  | ✅ Live | Query any REST API with custom endpoints         |
| **Hubspot**               | 🚧 Soon | Sync CRM contacts, companies, deals              |
| **Salesforce**            | 🚧 Soon | Sync CRM accounts, contacts, opportunities       |
| **Pipedrive**             | 🚧 Soon | Sync CRM deals, activities, contacts             |

## 🛠️ Quick Start

1. **Clone & Install**

   ```bash
   git clone https://github.com/mako-ai/mono.git
   cd mono
   pnpm install
   ```

2. **Configure Environment**
   Copy `.env.example` (if available) or create `.env`:

   ```env
   DATABASE_URL=mongodb://localhost:27017/mako
   ENCRYPTION_KEY=your_32_character_hex_key_for_encryption
   WEB_API_PORT=8080
   BASE_URL=http://localhost:8080
   CLIENT_URL=http://localhost:5173
   ```

3. **Start Services**

   ```bash
   # Start MongoDB and dependencies
   pnpm run docker:up

   # Start the full stack (API + App + Inngest)
   pnpm run dev
   ```

4. **Analyze**
   - Open **http://localhost:5173** to access the app.
   - Add a Data Source (e.g., Stripe or Close.com).
   - Use the chat interface to ask questions about your data.

## 🏗️ Architecture

Mako uses a modern, scalable architecture designed for flexibility and performance.

- **Frontend**: React + Vite (Web App), Next.js (Website)
- **Backend**: Node.js + Hono (API), Inngest (Job Queues)
- **Database**: MongoDB (Metadata & Data Warehouse)
- **Sync Engine**: Custom incremental sync with atomic collection swaps

## 💻 Development Commands

| Command              | Description                                 |
| -------------------- | ------------------------------------------- |
| `pnpm run dev`       | Start API, frontend, and Inngest dev server |
| `pnpm run sync`      | Run the interactive sync tool               |
| `pnpm run migrate`   | Run database migrations                     |
| `pnpm run docker:up` | Start MongoDB and other services            |
| `pnpm run test`      | Run test suite                              |
| `pnpm run build`     | Build all packages                          |

## 🤝 Community & Support

- **Documentation**: [docs.mako.ai](https://docs.mako.ai)
- **GitHub**: [mako-ai/mono](https://github.com/mako-ai/mono)
- **Website**: [mako.ai](https://mako.ai)

---

<p align="center">
  Built with ❤️ by the Mako Team. Open Source and self-hostable.
</p>
