/** Postgres-first dbt repository. Production and canary use the one-way cutover bridge. */
import { createDbtCutoverRepo } from "./cutover";
import { MongoDbtRepository } from "./mongo.repo";
import { PgDbtRepository } from "./pg.repo";
import type { DbtRepository } from "./types";

export * from "./types";
export { MongoDbtRepository } from "./mongo.repo";
export { PgDbtRepository, type PgDbtRepositoryDeps } from "./pg.repo";

const pg = new PgDbtRepository();
export const dbtRepo: DbtRepository =
  process.env.MAKO_DBT_FENCE_V1 === "1"
    ? createDbtCutoverRepo(pg, new MongoDbtRepository())
    : pg;
