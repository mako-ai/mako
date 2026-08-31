/**
 * ONE commit, wherever commits are listed — the app History popover and the
 * Source Control graph render this same row, so they read the same and act
 * the same: subject, `sha · author · when` (relative or absolute, the other
 * on hover), chips, a ⋯ menu, and an expandable list of the files the commit
 * touched, each opening its diff.
 */
import { formatDistanceToNowStrict } from "date-fns";
import {
  Box,
  Chip,
  CircularProgress,
  Collapse,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  ChevronDown as ExpandIcon,
  ChevronRight as CollapsedIcon,
  FileDiff as DiffIcon,
  MoreHorizontal as MoreIcon,
} from "lucide-react";
import type { AppCommit, AppCommitFile } from "../store/appsStore";

const STATUS_LETTER: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

export function CommitRow({
  commit,
  dense = false,
  timeFormat = "absolute",
  chips,
  expanded,
  onToggle,
  files,
  onFileClick,
  onMenu,
  leading,
}: {
  commit: AppCommit;
  /** Sidebar rail: one line, ellipsis; the popover shows two wrapped lines. */
  dense?: boolean;
  timeFormat?: "absolute" | "relative";
  chips?: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  /** undefined = loading; [] = nothing in scope. */
  files?: AppCommitFile[];
  /** Absent → the file is listed but not openable (outside any app). */
  onFileClick?: (file: AppCommitFile) => void;
  onMenu?: (anchor: HTMLElement) => void;
  /** Replaces the chevron (the graph's rail dot). */
  leading?: React.ReactNode;
}) {
  const when = new Date(commit.timestamp);
  const absolute = when.toLocaleString();
  const relative = formatDistanceToNowStrict(when, { addSuffix: true });
  return (
    <Box sx={{ borderBottom: dense ? 0 : 1, borderColor: "divider" }}>
      <Box
        onClick={onToggle}
        sx={{
          display: "flex",
          alignItems: "flex-start",
          gap: 0.5,
          px: dense ? 1.5 : 1,
          py: dense ? 0.5 : 1,
          cursor: "pointer",
          "&:hover": { bgcolor: "action.hover" },
          "&:hover .commit-row-menu": { opacity: 1 },
        }}
      >
        <Box sx={{ pt: dense ? 0.4 : 0.25, color: "text.secondary" }}>
          {leading ??
            (expanded ? <ExpandIcon size={16} /> : <CollapsedIcon size={16} />)}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="body2"
            sx={{
              color: "text.primary",
              fontSize: dense ? 13 : undefined,
              ...(dense && !expanded
                ? {
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }
                : {
                    overflowWrap: "anywhere",
                    display: "-webkit-box",
                    WebkitLineClamp: expanded ? "unset" : 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }),
            }}
          >
            {commit.subject}
          </Typography>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.75,
              mt: 0.25,
              flexWrap: dense ? "nowrap" : "wrap",
              minWidth: 0,
            }}
          >
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontFamily: "monospace", flexShrink: 0 }}
            >
              {commit.oid.slice(0, 7)}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {commit.author}
            </Typography>
            <Tooltip title={timeFormat === "relative" ? absolute : relative}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ flexShrink: 0, whiteSpace: "nowrap" }}
              >
                · {timeFormat === "relative" ? relative : absolute}
              </Typography>
            </Tooltip>
            {chips}
          </Box>
        </Box>
        {onMenu && (
          <Tooltip title="Actions">
            <IconButton
              className="commit-row-menu"
              size="small"
              sx={{ opacity: dense ? 0 : 1, transition: "opacity 120ms" }}
              onClick={e => {
                e.stopPropagation();
                onMenu(e.currentTarget);
              }}
            >
              <MoreIcon size={16} />
            </IconButton>
          </Tooltip>
        )}
      </Box>
      <Collapse in={expanded} unmountOnExit>
        <Box sx={{ pl: dense ? 4.5 : 4, pr: 1, pb: 1 }}>
          {!files ? (
            <CircularProgress size={14} sx={{ ml: 1, my: 0.5 }} />
          ) : files.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              No files changed.
            </Typography>
          ) : (
            files.map(f => {
              const openable = Boolean(onFileClick);
              return (
                <Box
                  key={f.path}
                  onClick={e => {
                    e.stopPropagation();
                    onFileClick?.(f);
                  }}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    px: 1,
                    py: 0.25,
                    borderRadius: 1,
                    cursor: openable ? "pointer" : "default",
                    "&:hover": openable ? { bgcolor: "action.hover" } : {},
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      fontFamily: "monospace",
                      width: 12,
                      flexShrink: 0,
                      color:
                        f.status === "deleted"
                          ? "error.main"
                          : f.status === "added"
                            ? "success.main"
                            : "text.secondary",
                    }}
                  >
                    {STATUS_LETTER[f.status] ?? "M"}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      fontFamily: "monospace",
                      color: "text.primary",
                      overflowWrap: "anywhere",
                      minWidth: 0,
                    }}
                  >
                    {f.path}
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  {openable && <DiffIcon size={13} style={{ opacity: 0.6 }} />}
                </Box>
              );
            })
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

/** Small status chip shared by both commit lists. */
export function CommitChip({
  label,
  color,
  icon,
  outlined,
}: {
  label: string;
  color?: "success" | "primary" | "default";
  icon?: React.ReactElement;
  outlined?: boolean;
}) {
  return (
    <Chip
      size="small"
      color={color}
      variant={outlined ? "outlined" : "filled"}
      icon={icon}
      label={label}
      sx={{ height: 18, fontSize: "0.65rem" }}
    />
  );
}
