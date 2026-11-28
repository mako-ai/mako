/** Notification rules and delivery history. The cutover fence selects the authoritative store. */
import { createControlPlaneRepo } from "../control-plane-fence";
import { MongoNotificationsRepository } from "./mongo.repo";
import { PgNotificationsRepository } from "./pg.repo";
import type { NotificationsRepository } from "./types";

export * from "./types";
export { MongoNotificationsRepository } from "./mongo.repo";
export { PgNotificationsRepository } from "./pg.repo";

export const notificationsRepo: NotificationsRepository =
  createControlPlaneRepo<NotificationsRepository>(
    "notifications",
    new PgNotificationsRepository(),
    new MongoNotificationsRepository(),
    [
      "listRulesForResource",
      "listEnabledRulesForTrigger",
      "findRuleInWorkspace",
      "listDeliveriesForResource",
    ],
  );
