/** Explicit legacy store for suites that seed and inspect the Mongo dbt collections. */
import { MongoDbtRepository } from "../repositories/dbt/mongo.repo";

export * from "../repositories/dbt/types";
export const dbtRepo = new MongoDbtRepository();
