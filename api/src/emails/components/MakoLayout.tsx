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

/** Inline SVG wordmark — avoids external image hosts for reliable inbox rendering */
function MakoWordmark() {
  return (
    <Img
      alt="Mako"
      src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2288%22%20height%3D%2224%22%20viewBox%3D%220%200%2088%2024%22%20fill%3D%22none%22%3E%3Ctext%20x%3D%220%22%20y%3D%2218%22%20fill%3D%22%23111827%22%20font-family%3D%22system-ui%2CSegoe%20UI%2Csans-serif%22%20font-size%3D%2218%22%20font-weight%3D%22600%22%3EMako%3C%2Ftext%3E%3C%2Fsvg%3E"
      width={88}
      height={24}
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
            {footerNote ? (
              <Text style={mutedStyle}>{footerNote}</Text>
            ) : null}
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
