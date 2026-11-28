/** Postgres-first dbt repository. Production and canary use the one-way cutover bridge. */
import { createDbtCutoverRepo } from "./cutover";
import { MongoDbtRepository } from "./mongo.repo";
import { PgDbtRepository } from "./pg.repo";
import type { DbtRepository } from "./types";

export * from "./types";
export { MongoDbtRepository } from "./mongo.repo";
export { PgDbtRepository, type PgDbtRepositoryDeps } from "./pg.repo";

const pg = new PgDbtRepository();
// The PR workflow assigns this Cloud Run service its preview Postgres database.
const preview = /^mako-pr-\d+$/.test(process.env.K_SERVICE ?? "");
const production =
  process.env.NODE_ENV === "production" || !!process.env.K_SERVICE;
export const dbtRepo: DbtRepository =
  process.env.MAKO_DBT_FENCE_V1 === "1" || (production && !preview)
    ? createDbtCutoverRepo(pg, new MongoDbtRepository())
    : pg;
