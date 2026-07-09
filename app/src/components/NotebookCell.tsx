import {
  Box,
  IconButton,
  MenuItem,
  Select,
  TextField,
  Tooltip,
  useTheme,
} from "@mui/material";
import Editor from "@monaco-editor/react";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";

import type { NotebookBlock, NotebookBlockType } from "../store/notebookStore";

const MONACO_LANGUAGE: Record<NotebookBlockType, string | null> = {
  code: "python",
  sql: "sql",
  markdown: null,
};

/** Size a code/SQL editor to its content, clamped so long cells scroll. */
function editorHeight(source: string): number {
  const lines = Math.max(source.split("\n").length, 2);
  return Math.min(lines * 19 + 16, 360);
}

interface NotebookCellProps {
  block: NotebookBlock;
  index: number;
  count: number;
  onChange: (patch: Partial<NotebookBlock>) => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
}

export default function NotebookCell({
  block,
  index,
  count,
  onChange,
  onDelete,
  onMove,
}: NotebookCellProps) {
  const theme = useTheme();
  const monacoLanguage = MONACO_LANGUAGE[block.type];

  return (
    <Box
      sx={{
        mb: 1.5,
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        overflow: "hidden",
        "&:hover .cell-actions": { opacity: 1 },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          px: 0.5,
          py: 0.25,
          bgcolor: "action.hover",
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Select
          value={block.type}
          size="small"
          variant="standard"
          disableUnderline
          onChange={e =>
            onChange({ type: e.target.value as NotebookBlockType })
          }
          sx={{
            fontSize: "0.68rem",
            letterSpacing: 0.5,
            textTransform: "uppercase",
            ".MuiSelect-select": { py: 0.25, pl: 1, pr: 3 },
          }}
        >
          <MenuItem value="code">Python</MenuItem>
          <MenuItem value="sql">SQL</MenuItem>
          <MenuItem value="markdown">Markdown</MenuItem>
        </Select>

        <Box sx={{ flex: 1 }} />

        <Box
          className="cell-actions"
          sx={{ display: "flex", opacity: 0, transition: "opacity 120ms" }}
        >
          <Tooltip title="Move up">
            <span>
              <IconButton
                size="small"
                disabled={index === 0}
                onClick={() => onMove(-1)}
              >
                <ChevronUp size={15} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Move down">
            <span>
              <IconButton
                size="small"
                disabled={index === count - 1}
                onClick={() => onMove(1)}
              >
                <ChevronDown size={15} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Delete cell">
            <IconButton size="small" onClick={onDelete}>
              <Trash2 size={15} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {monacoLanguage ? (
        <Editor
          language={monacoLanguage}
          value={block.source}
          onChange={value => onChange({ source: value ?? "" })}
          theme={theme.palette.mode === "dark" ? "vs-dark" : "light"}
          height={editorHeight(block.source)}
          options={{
            minimap: { enabled: false },
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            fontSize: 13,
            folding: false,
            wordWrap: "on",
            automaticLayout: true,
            scrollbar: { alwaysConsumeMouseWheel: false },
            padding: { top: 8, bottom: 8 },
          }}
        />
      ) : (
        <TextField
          value={block.source}
          onChange={e => onChange({ source: e.target.value })}
          placeholder="Markdown…"
          multiline
          fullWidth
          minRows={2}
          variant="standard"
          InputProps={{
            disableUnderline: true,
            sx: { fontSize: "0.85rem", p: 1, alignItems: "flex-start" },
          }}
        />
      )}
    </Box>
  );
}
