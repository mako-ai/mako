import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  Box,
  IconButton,
  InputBase,
  Tooltip,
  Typography,
} from "@mui/material";
import { Search as SearchIcon, X as ClearIcon } from "lucide-react";

export interface ExplorerShellProps {
  title: string;
  actions?: ReactNode;
  searchPlaceholder?: string;
  /**
   * Fired whenever the effective search query changes, debounced by
   * `searchDebounceMs` (default 400ms). Empty string is emitted when the user
   * clears the field or closes the search input.
   */
  onSearchChange?: (query: string) => void;
  searchDebounceMs?: number;
  error?: string | null;
  onErrorClose?: () => void;
  loading?: boolean;
  skeleton?: ReactNode;
  /**
   * Render-prop for the body. Receives the current debounced search query so
   * consumers can pass it directly to a tree's `searchQuery` prop (client-side
   * filtering). Also receives the raw, un-debounced value for UI concerns
   * like "show 'no matches' hint".
   */
  children: (ctx: { searchQuery: string; rawSearchQuery: string }) => ReactNode;
}

export default function ExplorerShell({
  title,
  actions,
  searchPlaceholder = "Search...",
  onSearchChange,
  searchDebounceMs = 400,
  error,
  onErrorClose,
  loading = false,
  skeleton,
  children,
}: ExplorerShellProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setDebouncedQuery(rawQuery);
    }, searchDebounceMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [rawQuery, searchDebounceMs]);

  useEffect(() => {
    onSearchChange?.(debouncedQuery);
  }, [debouncedQuery, onSearchChange]);

  const handleSearchOpen = useCallback(() => {
    setSearchOpen(true);
  }, []);

  const handleSearchClose = useCallback(() => {
    setRawQuery("");
    setDebouncedQuery("");
    setSearchOpen(false);
  }, []);

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box
        sx={{
          px: 1,
          py: 0.25,
          minHeight: 37,
          borderBottom: 1,
          borderColor: "divider",
          display: "flex",
          alignItems: "center",
          gap: 0.5,
        }}
      >
        {searchOpen ? (
          <InputBase
            autoFocus
            inputRef={searchInputRef}
            placeholder={searchPlaceholder}
            value={rawQuery}
            onChange={e => setRawQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Escape") handleSearchClose();
            }}
            startAdornment={
              <SearchIcon
                size={14}
                style={{ marginLeft: 6, marginRight: 6, flexShrink: 0 }}
              />
            }
            sx={{
              flex: 1,
              minWidth: 0,
              height: 28,
              fontSize: "0.85rem",
              bgcolor: "background.paper",
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              "&.Mui-focused": { borderColor: "primary.main" },
              "& .MuiInputBase-input": {
                p: 0,
                height: "100%",
                "&:focus": { outline: "none" },
              },
            }}
          />
        ) : (
          <Box sx={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
            <Typography
              variant="h6"
              sx={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                textTransform: "uppercase",
              }}
            >
              {title}
            </Typography>
          </Box>
        )}
        <Box sx={{ display: "flex", gap: 0, flexShrink: 0 }}>
          {!searchOpen && actions}
          <Tooltip title={searchOpen ? "Close search" : "Search"}>
            <IconButton
              onClick={searchOpen ? handleSearchClose : handleSearchOpen}
              size="small"
            >
              {searchOpen ? (
                <ClearIcon size={20} strokeWidth={2} />
              ) : (
                <SearchIcon size={20} strokeWidth={2} />
              )}
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" onClose={onErrorClose} sx={{ mx: 2, mt: 2 }}>
          {error}
        </Alert>
      )}

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {loading && skeleton
          ? skeleton
          : children({ searchQuery: debouncedQuery, rawSearchQuery: rawQuery })}
      </Box>
    </Box>
  );
}
