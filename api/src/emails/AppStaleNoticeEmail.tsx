import { Heading, Link, Section, Text } from "react-email";
import type { FC } from "react";
import { MakoLayout } from "./components/MakoLayout";
import type { EmailTemplate } from "./render";

export interface AppStaleNoticeEmailProps {
  workspaceName: string;
  /** ISO date (YYYY-MM-DD) the apps are archived on unless used. */
  archiveOn: string;
  apps: Array<{ title: string; path: string; url?: string }>;
}

/**
 * The stale-app notice (app-lifecycle.service.ts): one digest per person
 * per run, listing every app of theirs the job will archive in 14 days.
 */
const AppStaleNoticeEmail: FC<AppStaleNoticeEmailProps> = props => {
  const many = props.apps.length > 1;
  return (
    <MakoLayout
      previewText={`${props.apps.length} app${many ? "s" : ""} in ${props.workspaceName} will be archived on ${props.archiveOn}`}
      footerNote={`Workspace: ${props.workspaceName}`}
    >
      <Heading
        style={{ fontSize: "22px", margin: "0 0 16px", color: "#18181b" }}
      >
        {many
          ? "Some of your apps look unused"
          : "One of your apps looks unused"}
      </Heading>
      <Text
        style={{
          fontSize: "15px",
          lineHeight: "22px",
          color: "#3f3f46",
          margin: "0 0 16px",
        }}
      >
        Nobody else has opened {many ? "these apps" : "this app"} in 60 days,
        and nobody has changed {many ? "them" : "it"} either.{" "}
        {many ? "They" : "It"} will be archived on{" "}
        <strong>{props.archiveOn}</strong> unless someone opens or edits{" "}
        {many ? "them" : "it"} before then. Archived apps stay in the workspace
        repo under <code>archive/</code> and can be restored at any time.
      </Text>
      <Section
        style={{
          backgroundColor: "#fafafa",
          borderRadius: "6px",
          padding: "14px 16px",
          marginBottom: "20px",
        }}
      >
        {props.apps.map(app => (
          <Text
            key={app.path}
            style={{
              fontSize: "14px",
              lineHeight: "20px",
              color: "#27272a",
              margin: "0 0 6px",
            }}
          >
            {app.url ? <Link href={app.url}>{app.title}</Link> : app.title}{" "}
            <span style={{ color: "#71717a" }}>({app.path})</span>
          </Text>
        ))}
      </Section>
    </MakoLayout>
  );
};

export const AppStaleNoticeTemplate: EmailTemplate<AppStaleNoticeEmailProps> = {
  Component: AppStaleNoticeEmail,
  subject: props =>
    props.apps.length === 1
      ? `Mako: "${props.apps[0].title}" will be archived on ${props.archiveOn}`
      : `Mako: ${props.apps.length} apps will be archived on ${props.archiveOn}`,
};
