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
 * Logo URL — defaults to the PNG hosted on the Mako app domain (`app.mako.ai`
 * via Cloudflare's edge CDN, sourced from `app/public/email/mako-logo.png`).
 * Override with `EMAIL_LOGO_URL` for staging / preview deploys.
 *
 * We deliberately use a hosted PNG rather than a `data:` URI (stripped by
 * Gmail), an inline-SVG (no Outlook-desktop support), or a CID attachment
 * (heavier per-message, complicates the mail pipeline) — see the notes in
 * `docs/notifications.md`.
 */
const LOGO_URL =
  process.env.EMAIL_LOGO_URL ?? "https://app.mako.ai/email/mako-logo.png";

function MakoLogo() {
  return (
    <Img
      src={LOGO_URL}
      alt="Mako"
      width={120}
      height={60}
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
            <MakoLogo />
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
  // Fallback styling for clients that block remote images and surface alt text.
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
