import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { ReactNode } from "react";

export interface MakoLayoutProps {
  previewText: string;
  /** Short note shown above footer (e.g. workspace line) */
  footerNote?: string;
  children: ReactNode;
}

/**
 * Logo is referenced via a Content-ID (`cid:`) URL and shipped as an inline
 * SendGrid attachment (see `api/src/emails/assets/index.ts` and
 * `email.service.ts`). This works in Gmail, Apple Mail, iOS Mail and Outlook
 * web without depending on a public asset host. Clients that don't render SVG
 * (e.g. Outlook desktop on Windows) fall back to the styled `Mako` alt text.
 */
function MakoWordmark() {
  return (
    <Img
      src="cid:mako-logo"
      alt="Mako"
      width={36}
      height={32}
      style={logoImgStyle}
    />
  );
}

export function MakoLayout({
  previewText,
  footerNote,
  children,
}: MakoLayoutProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Section style={headerStyle}>
            <MakoWordmark />
          </Section>
          {children}
          <Hr style={hrStyle} />
          <Section style={footerStyle}>
            {footerNote ? <Text style={mutedStyle}>{footerNote}</Text> : null}
            <Text style={mutedStyle}>
              You receive this email because a notification rule was configured
              for this workspace in Mako. Adjust rules from the app under Run
              notifications.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const bodyStyle = {
  backgroundColor: "#f4f4f5",
  fontFamily:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
  margin: 0,
  padding: "32px 16px",
};

const containerStyle = {
  backgroundColor: "#ffffff",
  borderRadius: "8px",
  padding: "28px 24px",
  maxWidth: "560px",
  margin: "0 auto",
};

const headerStyle = {
  marginBottom: "24px",
};

const logoImgStyle = {
  display: "block",
  // alt text styling — only seen when SVG fails to render
  color: "#111827",
  fontSize: "20px",
  fontWeight: 700,
  fontFamily:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
};

const hrStyle = {
  borderColor: "#e4e4e7",
  margin: "28px 0 20px",
};

const footerStyle = {
  marginTop: "8px",
};

const mutedStyle = {
  color: "#71717a",
  fontSize: "12px",
  lineHeight: "18px",
  margin: "0 0 10px",
};
