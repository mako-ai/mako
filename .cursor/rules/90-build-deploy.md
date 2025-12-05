# Build & Deploy Rules

- Do not edit generated files in `dist/**`. Sources live in `api/src/**` and `app/src/**`.
- API Docker dev image: [api/Dockerfile.dev](mdc:api/Dockerfile.dev). Production Dockerfile: [Dockerfile](mdc:Dockerfile).
- Deployment scripts and env: [deploy.sh](mdc:deploy.sh), [env.yaml](mdc:env.yaml), [cloud-run-env.yaml](mdc:cloud-run-env.yaml).
- Inngest local/dev configuration: [INNGEST_DEV_CONFIG.md](mdc:INNGEST_DEV_CONFIG.md).
- If a change requires new environment variables, document them in `env.yaml` and update relevant READMEs.
- Database migrations run automatically after deploy. See [90-migrations.mdc](mdc:.cursor/rules/90-migrations.mdc).

Environment variables (local defaults):

- `WEB_API_PORT=8080` (API server)
- `BASE_URL=http://localhost:8080` (API base for OAuth callbacks)
- `CLIENT_URL=http://localhost:5173` (frontend base URL)
