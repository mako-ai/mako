import { setTimeout as sleep } from "node:timers/promises";
import type Stripe from "stripe";

export interface SetupAttemptWalk {
  parents: string[];
  nextParentPage?: string;
  attemptAfter?: string;
}

function nextCursor<T extends { id: string }>(
  page: Stripe.ApiList<T>,
  startingAfter: string | undefined,
): string | undefined {
  if (!page.has_more) return undefined;
  const last = page.data.at(-1)?.id;
  if (!last || last === startingAfter) {
    throw new Error("Stripe Setup Attempts pagination did not advance");
  }
  return last;
}

/** One Stripe request per batch, including batches that only advance state. */
export async function* readSetupAttempts(
  stripe: Stripe,
  previous: SetupAttemptWalk | undefined,
  options: { limit: number; delayMs: number; since?: Date; anchor?: string },
) {
  let walk = previous ?? { parents: [] };
  let hasMore = !previous || walk.parents.length > 0 || !!walk.nextParentPage;
  let first = true;
  while (hasMore) {
    if (!first) await sleep(options.delayMs);
    first = false;
    let records: Stripe.SetupAttempt[] = [];
    const [parent, ...rest] = walk.parents;
    if (parent === undefined) {
      // A new attempt can belong to an intent created before the anchor.
      const page = await stripe.setupIntents.list({
        limit: options.limit,
        starting_after: walk.nextParentPage,
      });
      walk = {
        parents: page.data.map(intent => intent.id),
        nextParentPage: nextCursor(page, walk.nextParentPage),
      };
    } else {
      const page = await stripe.setupAttempts.list({
        setup_intent: parent,
        limit: options.limit,
        starting_after: walk.attemptAfter,
        ...(options.since && {
          created: { gte: Math.floor(options.since.getTime() / 1000) },
        }),
      });
      records = page.data;
      const attemptAfter = nextCursor(page, walk.attemptAfter);
      walk = attemptAfter
        ? { ...walk, attemptAfter }
        : { parents: rest, nextParentPage: walk.nextParentPage };
    }
    hasMore = walk.parents.length > 0 || !!walk.nextParentPage;
    yield {
      records,
      state: {
        setupAttempts: walk,
        ...(options.anchor ? { mako: { since: options.anchor } } : {}),
      },
      hasMore,
    };
  }
}
