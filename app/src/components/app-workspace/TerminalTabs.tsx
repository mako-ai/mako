import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  Box,
  Button,
  Chip,
  IconButton,
  Tooltip,
  Typography,
  styled,
} from "@mui/material";
import { Plus as PlusIcon, TerminalSquare as TerminalIcon } from "lucide-react";
import { devServerKeyMatches, useAppsStore } from "../../store/appsStore";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
} from "react-resizable-panels";
import { useIsMobile } from "../../hooks/useIsMobile";
import { clickableProps } from "../../lib/a11y";
import { TerminalPanel } from "./TerminalPanel";
import { MOBILE_TERMINAL_KEYS, useHiddenPause } from "./terminal-utils";

/**
 * The divider between the preview and the terminal.
 *
 * Same 4px as the side handles in App.tsx rather than a hand-picked height, so
 * the three dividers on screen are actually the same thickness — they were not
 * before, and it showed.
 */
/** Vertical divider between the terminal panes and the sessions list. */
const SessionsResizeHandle = styled(Separator)(({ theme }) => ({
  flex: "0 0 4px",
  width: "4px",
  alignSelf: "stretch",
  background: theme.palette.divider,
  touchAction: "none",
  transition: "background-color 0.2s ease",
  "&[data-separator='hover'], &[data-separator='active']": {
    backgroundColor: theme.palette.primary.main,
  },
}));

/**
 * VS Code-shaped terminal area: a tab bar over N shells plus one read-only
 * "Dev server" tab that owns the vite output for good — it does not vanish
 * when the preview goes live, so "what did the dev server say" always has an
 * answer. Every shell tab is a real PTY of its own in the same sandbox;
 * closed tabs detach and the server reaps the idle shell.
 */
export function TerminalTabs({
  appId,
  workspaceId,
}: {
  appId: string;
  workspaceId: string;
}) {
  // Shell tabs survive reloads: each tab is a PTY keyed by its id on the
  // server, and those sessions outlive the page — restoring the same ids
  // reattaches to the same running shells (scrollback and all), VS Code
  // style. Only the tab LIST is persisted; which tab is active is not worth
  // remembering.
  const hiddenPaused = useHiddenPause();
  const sessionsLayout = useDefaultLayout({
    id: "apps-terminal-sessions",
    storage: localStorage,
  });
  const [shells, setShells] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(`apps-shells:${appId}`) ?? "[]",
      ) as unknown;
      if (
        Array.isArray(saved) &&
        saved.length > 0 &&
        saved.every(x => typeof x === "string" && /^[0-9]{1,6}$/.test(x))
      ) {
        return saved;
      }
    } catch {
      // Corrupt or unavailable storage — fall through to the default.
    }
    // No free shell by default: starting dev opens exactly ONE terminal —
    // the dev process. Extra shells are a deliberate click on +.
    return [];
  });
  // The active session survives reloads like everything else about the
  // terminal area: sessions and their scrollback live server-side, so the
  // page coming back on a different tab than you were working in reads as
  // state loss even though nothing was lost.
  const [active, setActiveState] = useState<string>(() => {
    try {
      // Never auto-select the dev terminal: selecting it ATTACHES to (and
      // waits for) a dev server, which must not happen on mount just because
      // it was focused last time. Restore a saved BASH tab only; the dev tab
      // is entered by an explicit click (apps.md §13.11).
      const saved = localStorage.getItem(`apps-term-active:${appId}`);
      if (saved && /^[0-9]{1,6}$/.test(saved)) return saved;
    } catch {
      // Storage unavailable — default below.
    }
    return "1";
  });
  const setActive = useCallback(
    (id: string) => {
      setActiveState(id);
      try {
        localStorage.setItem(`apps-term-active:${appId}`, id);
      } catch {
        // Best effort.
      }
    },
    [appId],
  );
  // A persisted shell id whose tab was closed in another session falls back
  // to the dev window instead of pointing at nothing.
  useEffect(() => {
    if (active !== "dev" && !shells.includes(active)) {
      setActiveState(shells[0] ?? "dev");
    }
  }, [active, shells]);
  const nextId = useRef(Math.max(0, ...shells.map(Number)) + 1);
  // Ids born in this pageview — their sessions have no history to replay,
  // and telling the server so skips a probe round-trip on open.
  const freshIds = useRef<Set<string>>(new Set());
  const killTerminalSession = useAppsStore(st => st.killTerminalSession);
  const stopDev = useAppsStore(st => st.stopDev);
  // Box truth: sessions that exist server-side (pushed by the agent).
  const boxTerminals = useAppsStore(st => st.boxTerminals);
  // One path for both ways a shell dies: the x on its row (killRemote —
  // closing the tab kills the pty, the dtach session and the recording) and
  // the session ending on its own (`exit` — already dead, just drop the tab).
  const closeShell = useCallback(
    (id: string, opts: { killRemote: boolean }) => {
      if (opts.killRemote) {
        void killTerminalSession(workspaceId, appId, id);
      }
      // An empty shell list is fine now — the dev terminal is the floor.
      // (No id reuse either: a reused id kept the dead TerminalPanel's
      // React key, leaving a corpse stuck on "connecting".)
      setShells(prev => prev.filter(x => x !== id));
      setActiveState(current => (current === id ? "dev" : current));
    },
    [appId, workspaceId, killTerminalSession],
  );
  useEffect(() => {
    try {
      localStorage.setItem(`apps-shells:${appId}`, JSON.stringify(shells));
    } catch {
      // Best effort.
    }
  }, [appId, shells]);

  const slug = useAppsStore(
    st => st.apps.find(a => a.id === appId)?.slug ?? null,
  );
  // Box truth: is a dev server actually serving this app? The dev terminal
  // attaches to it only when it IS running or the user explicitly selects it —
  // never on mount for a stopped app, which used to spawn a "[waiting for the
  // dev server]" attach with nothing behind it (apps.md §13.11).
  const runningDevApps = useAppsStore(st => st.runningDevApps);
  const devRunning = runningDevApps.some(k =>
    devServerKeyMatches(k, { id: appId, slug: slug ?? undefined }),
  );
  const isMobile = useIsMobile();
  // One writer ref per terminal id, handed to its TerminalPanel; the mobile
  // key bar writes through the active one. Refs, not state: a socket coming
  // up must not re-render the tab bar.
  const inputRefs = useRef<
    Record<string, MutableRefObject<((data: string) => void) | null>>
  >({});
  const inputRefFor = (id: string) =>
    (inputRefs.current[id] ??= { current: null });

  const addShell = () => {
    // Never mint an id the BOX already has a session for: with a detached
    // ghost "1" on screen, + used to create id 1 — silently adopting the old
    // shell (cwd, state) while presenting it as fresh. Skip every id in use,
    // client-side or box-side.
    const used = new Set([
      ...shells,
      ...boxTerminals.filter(t => /^[0-9]+$/.test(t)),
    ]);
    let n = nextId.current;
    while (used.has(String(n))) n += 1;
    nextId.current = n + 1;
    const id = String(n);
    freshIds.current.add(id);
    setShells(prev => [...prev, id]);
    setActive(id);
  };

  // ONE session list for both layouts: the desktop column and the mobile chip
  // row. Dev server first (server-side it is a tmux session like any other),
  // then this pageview's shells, then GHOST sessions — shells that exist in
  // the box (pushed truth) but have no tab here: opened by the agent, another
  // browser, or a previous pageview. One tap attaches, history and all;
  // invisible sessions were how people collided with them.
  // The dev session is named by the app's ID server-side (dev-server.service
  // keys the dtach socket, history and launcher by it — folder basenames are
  // not unique once apps nest), so the terminal id must be too; the label
  // keeps the human-readable slug.
  const devTermId = `dev-${appId}`;
  const sessionItems: {
    key: string;
    termId: string;
    label: string;
    selected: boolean;
    onSelect: () => void;
    onClose?: () => void;
  }[] = [
    {
      key: "dev",
      termId: devTermId,
      label: slug
        ? `dev: ${slug}${devRunning ? "" : " · stopped"}`
        : "dev server",
      selected: active === "dev",
      onSelect: () => setActive("dev"),
      // Closing the dev session IS stopping dev mode — one mental model,
      // same as the toolbar's Stop dev.
      onClose: devRunning ? () => void stopDev(workspaceId, appId) : undefined,
    },
    ...shells.map((id, index) => ({
      key: id,
      termId: id,
      label: `bash ${index + 1}`,
      selected: active === id,
      onSelect: () => setActive(id),
      onClose: () => closeShell(id, { killRemote: true }),
    })),
    ...boxTerminals
      .filter(id => /^[0-9]+$/.test(id) && !shells.includes(id))
      .map(id => ({
        key: `ghost-${id}`,
        termId: id,
        label: `bash · detached (${id})`,
        selected: false,
        onSelect: () => {
          setShells(prev => (prev.includes(id) ? prev : [...prev, id]));
          setActive(id);
        },
      })),
  ];

  // Every pane STAYS MOUNTED — an unmounted xterm is a dropped session and a
  // re-scroll; hiding keeps the socket, the scrollback and the dev-log offset
  // alive across switches.
  const terminalPanes = (
    <Box
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: active === "dev" ? "block" : "none",
        }}
      >
        {!hiddenPaused && slug && (devRunning || active === "dev") ? (
          // The dev server runs in a dtach session named like any other
          // (mako-term-dev-<slug>) — this is a normal terminal attached
          // to it: colors, native scrollback, prefit history, and Ctrl-C
          // reaches vite. Mounted only when a server is actually running
          // (box truth) or the user selected this tab — never on mount for
          // a stopped app, which would attach a waiter to nothing.
          <TerminalPanel
            appId={appId}
            workspaceId={workspaceId}
            termId={devTermId}
            label={`dev: ${slug}`}
            inputRef={inputRefFor(devTermId)}
          />
        ) : null}
      </Box>
      {!hiddenPaused &&
        shells.map((id, index) => (
          <Box
            key={id}
            sx={{
              flex: 1,
              minHeight: 0,
              display: active === id ? "block" : "none",
            }}
          >
            <TerminalPanel
              appId={appId}
              workspaceId={workspaceId}
              termId={id}
              label={`bash ${index + 1}`}
              fresh={freshIds.current.has(id)}
              onSessionEnd={() => closeShell(id, { killRemote: false })}
              inputRef={inputRefFor(id)}
            />
          </Box>
        ))}
    </Box>
  );

  if (isMobile) {
    // Phone anatomy: sessions as a chip row on top (the column would eat a
    // third of the width), the shell filling the pane, and a key bar above
    // the soft keyboard for the keys it does not have.
    const activeTermId = active === "dev" ? devTermId : active;
    const sendKey = (seq: string) => inputRefFor(activeTermId).current?.(seq);
    return (
      <Box
        sx={{
          height: "100%",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            px: 1,
            py: 0.75,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              gap: 0.75,
              overflowX: "auto",
              scrollbarWidth: "none",
              "&::-webkit-scrollbar": { display: "none" },
            }}
          >
            {sessionItems.map(item => (
              <Chip
                key={item.key}
                icon={<TerminalIcon size={14} strokeWidth={1.75} />}
                label={item.label}
                variant={item.selected ? "filled" : "outlined"}
                onClick={item.onSelect}
                onDelete={item.onClose}
                sx={{
                  flexShrink: 0,
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", monospace',
                  fontSize: 12,
                }}
              />
            ))}
          </Box>
          <Tooltip title="New terminal — another real shell in the same sandbox">
            <IconButton
              size="small"
              aria-label="New terminal"
              onClick={addShell}
            >
              <PlusIcon size={16} strokeWidth={2} />
            </IconButton>
          </Tooltip>
        </Box>
        {terminalPanes}
        <Box
          sx={{
            display: "flex",
            gap: 0.75,
            px: 1,
            py: 0.75,
            borderTop: 1,
            borderColor: "divider",
            bgcolor: "background.default",
          }}
        >
          {MOBILE_TERMINAL_KEYS.map(([label, seq]) => (
            <Button
              key={label}
              size="small"
              variant="outlined"
              color="inherit"
              aria-label={`Send ${label}`}
              // Keep focus (and the soft keyboard) on the terminal: a button
              // that takes focus on tap hides the keyboard on iOS.
              onPointerDown={e => e.preventDefault()}
              onClick={() => sendKey(seq)}
              sx={{
                flex: 1,
                minWidth: 0,
                px: 0,
                minHeight: 36,
                textTransform: "none",
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", monospace',
              }}
            >
              {label}
            </Button>
          ))}
        </Box>
      </Box>
    );
  }

  return (
    // VS Code's panel anatomy: the active session fills the area, and the
    // SESSION LIST is a slim vertical column on the right — the dev server
    // is simply the first session in it (server-side it runs in a tmux
    // session named mako-dev-<slug>, attachable from any shell), not a
    // special surface.
    <Group
      orientation="horizontal"
      defaultLayout={sessionsLayout.defaultLayout}
      onLayoutChanged={sessionsLayout.onLayoutChanged}
      style={{ height: "100%" }}
    >
      <Panel id="terminal-panes" minSize="40%">
        <Box sx={{ height: "100%", display: "flex" }}>{terminalPanes}</Box>
      </Panel>
      <SessionsResizeHandle />
      <Panel
        id="terminal-sessions"
        defaultSize="14%"
        minSize="7%"
        maxSize="40%"
      >
        <Box
          sx={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            overflowY: "auto",
          }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              pl: 1.25,
              pr: 0.25,
              py: 0.25,
            }}
          >
            <Typography
              variant="caption"
              sx={{
                flex: 1,
                fontSize: "0.66rem",
                fontWeight: 700,
                letterSpacing: 0.4,
                color: "text.secondary",
              }}
            >
              SESSIONS
            </Typography>
            <Tooltip title="New terminal — another real shell in the same sandbox">
              <IconButton size="small" onClick={addShell}>
                <PlusIcon size={13} strokeWidth={2} />
              </IconButton>
            </Tooltip>
          </Box>
          {sessionItems.map(item => (
            <SessionRow
              key={item.key}
              label={item.label}
              selected={item.selected}
              onSelect={item.onSelect}
              onClose={item.onClose}
            />
          ))}
        </Box>
      </Panel>
    </Group>
  );
}

/** One row of the VS Code-style session list beside the terminal. */
function SessionRow({
  label,
  selected,
  onSelect,
  onClose,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  onClose?: () => void;
}) {
  return (
    <Box
      onClick={onSelect}
      {...clickableProps(onSelect)}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.75,
        pl: 1.25,
        pr: 0.5,
        py: 0.4,
        cursor: "pointer",
        bgcolor: selected ? "action.selected" : "transparent",
        "&:hover": { bgcolor: selected ? "action.selected" : "action.hover" },
        "&:hover .a2-session-close": { opacity: 0.7 },
      }}
    >
      <TerminalIcon size={13} strokeWidth={1.75} />
      <Typography
        variant="caption"
        sx={{
          flex: 1,
          fontSize: 11.5,
          fontWeight: selected ? 650 : 400,
          color: selected ? "text.primary" : "text.secondary",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </Typography>
      {onClose && (
        <Box
          component="span"
          className="a2-session-close"
          onClick={e => {
            e.stopPropagation();
            onClose();
          }}
          {...clickableProps(onClose, `Close ${label}`)}
          sx={{
            fontSize: 12,
            opacity: 0,
            "&:hover, &:focus-visible": { opacity: 1 },
          }}
        >
          ×
        </Box>
      )}
    </Box>
  );
}
