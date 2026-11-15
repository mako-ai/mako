import { IconButton, Stack, Tooltip } from "@mui/material";
import { Ban, CircleCheck, Hand } from "lucide-react";
import { type McpToolRestriction } from "../../store/mcpStore";

/**
 * Claude-style three-state restriction control: Always-allowable (check),
 * Ask (hand), Block (ban). The admin picks a ceiling; members can always
 * choose a stricter setting for themselves.
 */
export function RestrictionControl({
  value,
  usesDefault,
  disabled,
  onChange,
}: {
  value: McpToolRestriction;
  usesDefault: boolean;
  disabled?: boolean;
  onChange: (value: McpToolRestriction) => void;
}) {
  const options: Array<{
    key: McpToolRestriction;
    label: string;
    icon: React.ReactNode;
  }> = [
    {
      key: "always",
      label: "Users can choose Always allow, Ask, or Block",
      icon: <CircleCheck size={14} />,
    },
    {
      key: "ask",
      label: "Users can choose Ask or Block — never Always allow",
      icon: <Hand size={14} />,
    },
    {
      key: "block",
      label: "Block this tool for everyone",
      icon: <Ban size={14} />,
    },
  ];
  return (
    <Stack direction="row" spacing={0.5}>
      {options.map(opt => {
        const selected = value === opt.key;
        return (
          <Tooltip key={opt.key} title={opt.label}>
            <span>
              <IconButton
                size="small"
                disabled={disabled}
                onClick={() => onChange(opt.key)}
                sx={{
                  border: 1,
                  borderColor: selected ? "text.primary" : "divider",
                  borderRadius: "50%",
                  width: 26,
                  height: 26,
                  color: selected ? "text.primary" : "text.disabled",
                  opacity: selected && usesDefault ? 0.75 : 1,
                  bgcolor: selected ? "action.selected" : "transparent",
                }}
              >
                {opt.icon}
              </IconButton>
            </span>
          </Tooltip>
        );
      })}
    </Stack>
  );
}
