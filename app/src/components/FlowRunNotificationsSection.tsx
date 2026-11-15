import { lazy, Suspense } from "react";
import type { FlowRunNotificationsSectionProps } from "./flow-run-notifications/FlowRunNotificationsPanel";

export type { FlowRunNotificationsSectionProps };

// Loaded on first use: the schedule-console modal imports this section from
// the entry chunk, and the rule editor (chips input, Slack/email forms) is
// only needed once a dialog or flow form actually shows it.
const FlowRunNotificationsPanel = lazy(
  () => import("./flow-run-notifications/FlowRunNotificationsPanel"),
);

/** Run-notification rules (email / Slack) for a flow or scheduled console. */
export function FlowRunNotificationsSection(
  props: FlowRunNotificationsSectionProps,
) {
  return (
    <Suspense fallback={null}>
      <FlowRunNotificationsPanel {...props} />
    </Suspense>
  );
}
