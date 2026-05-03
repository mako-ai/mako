import { Button } from "@react-email/components";

export interface MakoButtonProps {
  href: string;
  children: string;
}

/** Primary CTA — uses react-email Button (table-based, Outlook-friendly) */
export function MakoButton({ href, children }: MakoButtonProps) {
  return (
    <Button
      href={href}
      style={{
        backgroundColor: "#18181b",
        borderRadius: "6px",
        color: "#fafafa",
        fontSize: "14px",
        fontWeight: 600,
        textDecoration: "none",
        textAlign: "center" as const,
        display: "inline-block",
        padding: "12px 20px",
      }}
    >
      {children}
    </Button>
  );
}
