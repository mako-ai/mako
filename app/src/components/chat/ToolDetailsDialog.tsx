import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from "@mui/material";
import { safeStringify } from "../../lib/json-safe";
import { CodeBlock } from "./CodeBlock";
import type { ToolInvocationInfo } from "./tool-presentation";

interface ToolDetailsDialogProps {
  open: boolean;
  tool: ToolInvocationInfo | null;
  onClose: () => void;
  paletteMode: "light" | "dark";
}

/** Tool debug dialog: raw input/output of a tool call as scrollable JSON. */
export function ToolDetailsDialog({
  open,
  tool,
  onClose,
  paletteMode,
}: ToolDetailsDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>
        {tool ? `Tool: ${tool.toolName}` : "Tool Details"}
      </DialogTitle>
      <DialogContent dividers>
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            Input
          </Typography>
          <CodeBlock
            language="json"
            isGenerating={false}
            scrollable
            paletteMode={paletteMode}
          >
            {tool && tool.input !== undefined
              ? typeof tool.input === "string"
                ? tool.input
                : safeStringify(tool.input, 2)
              : "No input captured"}
          </CodeBlock>
        </Box>
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            Output
          </Typography>
          <CodeBlock
            language="json"
            isGenerating={false}
            scrollable
            paletteMode={paletteMode}
          >
            {tool && tool.output !== undefined
              ? typeof tool.output === "string"
                ? tool.output
                : safeStringify(tool.output, 2)
              : "No output captured"}
          </CodeBlock>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
