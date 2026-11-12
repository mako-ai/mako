import { Heading, Section, Text } from "react-email";
import type { FC } from "react";
import {
  dbtOutcomeWord,
  dbtSummaryLine,
  failedStepLabel,
  hiddenFailedStepCount,
  isDbtResourceType,
} from "../services/flow-run-notification.helpers";
import type { NotificationOutboundPayload } from "../services/flow-run-notification.types";
import { MakoButton } from "./components/MakoButton";
import { MakoLayout } from "./components/MakoLayout";
import type { EmailTemplate } from "./render";

export type RunNotificationEmailProps = NotificationOutboundPayload;

function resourceKindLabel(
  resourceType: NotificationOutboundPayload["resourceType"],
): string {
  return resourceType === "scheduled_query" ? "Scheduled query" : "Flow";
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60
    ? `${s.toFixed(s < 10 ? 1 : 0)} s`
    : `${(s / 60).toFixed(1)} min`;
}

function formatTriggerLabel(trigger: NotificationOutboundPayload["trigger"]) {
  return trigger === "failure" ? "failed" : "succeeded";
}

const MONO_FONT =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

/** dbt job run: outcome first, then the failing models and tests. */
const DbtRunNotificationEmail: FC<RunNotificationEmailProps> = props => {
  const outcome = dbtOutcomeWord(props);
  const environment = props.environment ? ` (${props.environment})` : "";
  const failedSteps = props.failedSteps ?? [];
  const hidden = hiddenFailedStepCount(props);
  const showRunError =
    props.trigger === "failure" &&
    props.errorMessage &&
    failedSteps.length === 0;

  return (
    <MakoLayout
      previewText={`dbt job "${props.resourceName}" ${outcome}${environment}`}
      footerNote={`Run ID: ${props.runId} · Finished: ${props.completedAt} · Workspace ID: ${props.workspaceId}`}
    >
      <Heading
        style={{ fontSize: "22px", margin: "0 0 8px", color: "#18181b" }}
      >
        dbt job {outcome}: {props.resourceName}
        {environment}
      </Heading>
      <Text
        style={{
          fontSize: "15px",
          lineHeight: "22px",
          color: "#3f3f46",
          margin: "0 0 16px",
        }}
      >
        {dbtSummaryLine(props)}
      </Text>
      {failedSteps.length > 0 || showRunError ? (
        <Section
          style={{
            backgroundColor: "#fafafa",
            borderRadius: "6px",
            padding: "14px 16px",
            marginBottom: "20px",
          }}
        >
          {failedSteps.map((step, idx) => (
            <Text
              key={`${idx}-${step.name.slice(0, 48)}`}
              style={{
                fontSize: "13px",
                lineHeight: "20px",
                color: "#52525b",
                margin: "0 0 10px",
                fontFamily: MONO_FONT,
              }}
            >
              <strong>{failedStepLabel(step)}</strong>
              {step.message ? (
                <>
                  <br />
                  {step.message}
                </>
              ) : null}
            </Text>
          ))}
          {hidden > 0 ? (
            <Text
              style={{
                fontSize: "13px",
                lineHeight: "20px",
                color: "#52525b",
                margin: "0",
              }}
            >
              …and {hidden} more
            </Text>
          ) : null}
          {showRunError ? (
            <Text
              style={{
                fontSize: "13px",
                lineHeight: "20px",
                color: "#52525b",
                margin: "0",
                fontFamily: MONO_FONT,
              }}
            >
              {props.errorMessage}
            </Text>
          ) : null}
        </Section>
      ) : null}
      {props.deepLink ? (
        <Section style={{ marginTop: "8px" }}>
          <MakoButton href={props.deepLink}>Open the run in Mako</MakoButton>
        </Section>
      ) : null}
    </MakoLayout>
  );
};

const RunNotificationEmail: FC<RunNotificationEmailProps> = props => {
  if (isDbtResourceType(props.resourceType)) {
    return <DbtRunNotificationEmail {...props} />;
  }
  const kind = resourceKindLabel(props.resourceType);
  const statusWord = formatTriggerLabel(props.trigger);
  const previewText = `${kind} "${props.resourceName}" ${statusWord}`;
  const footerNote = `Workspace ID: ${props.workspaceId}`;

  const detailLines: string[] = [
    `${kind}: ${props.resourceName}`,
    `Run ID: ${props.runId}`,
    `Finished: ${props.completedAt}`,
    `Trigger: ${props.trigger}${props.triggerType ? ` (${props.triggerType})` : ""}`,
    `Duration: ${formatDuration(props.durationMs)}`,
  ];

  if (props.rowCount !== undefined && props.rowCount !== null) {
    detailLines.push(`Rows: ${String(props.rowCount)}`);
  }
  if (props.errorMessage) {
    detailLines.push(`Error: ${props.errorMessage}`);
  }

  return (
    <MakoLayout previewText={previewText} footerNote={footerNote}>
      <Heading
        style={{ fontSize: "22px", margin: "0 0 16px", color: "#18181b" }}
      >
        Run {props.trigger === "failure" ? "failed" : "completed"}
      </Heading>
      <Text
        style={{
          fontSize: "15px",
          lineHeight: "22px",
          color: "#3f3f46",
          margin: "0 0 16px",
        }}
      >
        Your {kind.toLowerCase()} <strong>{props.resourceName}</strong>{" "}
        {props.trigger === "failure" ? "failed." : "finished successfully."}
      </Text>
      <Section
        style={{
          backgroundColor: "#fafafa",
          borderRadius: "6px",
          padding: "14px 16px",
          marginBottom: "20px",
        }}
      >
        {detailLines.map((line, idx) => (
          <Text
            key={`${idx}-${line.slice(0, 48)}`}
            style={{
              fontSize: "13px",
              lineHeight: "20px",
              color: "#52525b",
              margin: "0 0 6px",
              fontFamily: MONO_FONT,
            }}
          >
            {line}
          </Text>
        ))}
      </Section>
      {props.deepLink ? (
        <Section style={{ marginTop: "8px" }}>
          <MakoButton href={props.deepLink}>Open in Mako</MakoButton>
        </Section>
      ) : null}
    </MakoLayout>
  );
};

function runNotificationSubject(props: RunNotificationEmailProps): string {
  if (isDbtResourceType(props.resourceType)) {
    const environment = props.environment ? ` (${props.environment})` : "";
    return `Mako: dbt job "${props.resourceName}" ${dbtOutcomeWord(props)}${environment}`;
  }
  const kind = resourceKindLabel(props.resourceType);
  const verb = props.trigger === "failure" ? "failed" : "completed";
  return `Mako: ${kind} "${props.resourceName}" ${verb}`;
}

export const RunNotificationTemplate: EmailTemplate<RunNotificationEmailProps> =
  {
    Component: RunNotificationEmail,
    subject: runNotificationSubject,
  };
