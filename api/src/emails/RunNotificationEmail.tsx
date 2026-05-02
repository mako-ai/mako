import { Heading, Section, Text } from "@react-email/components";
import type { FC } from "react";
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
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${(s / 60).toFixed(1)} min`;
}

function formatTriggerLabel(trigger: NotificationOutboundPayload["trigger"]) {
  return trigger === "failure" ? "failed" : "succeeded";
}

const RunNotificationEmail: FC<RunNotificationEmailProps> = props => {
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
      <Heading style={{ fontSize: "22px", margin: "0 0 16px", color: "#18181b" }}>
        Run {props.trigger === "failure" ? "failed" : "completed"}
      </Heading>
      <Text style={{ fontSize: "15px", lineHeight: "22px", color: "#3f3f46", margin: "0 0 16px" }}>
        Your {kind.toLowerCase()}{" "}
        <strong>{props.resourceName}</strong>{" "}
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
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
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
  const kind = resourceKindLabel(props.resourceType);
  const verb = props.trigger === "failure" ? "failed" : "completed";
  return `Mako: ${kind} "${props.resourceName}" ${verb}`;
}

export const RunNotificationTemplate: EmailTemplate<RunNotificationEmailProps> =
  {
    Component: RunNotificationEmail,
    subject: runNotificationSubject,
  };
