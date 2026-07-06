import { useMediaQuery, useTheme } from "@mui/material";

/**
 * Single source of truth for the mobile breakpoint.
 *
 * Mako's desktop shell assumes ~1000px+ width. Anything below MUI's `md`
 * breakpoint (900px by default) switches to the chat-first, single-pane
 * mobile experience driven by `uiStore.mobileTab`.
 *
 * Components branch in place on this hook — there is intentionally no parallel
 * mobile component tree.
 */
export function useIsMobile(): boolean {
  const theme = useTheme();
  // `noSsr` keeps the very first client render correct (no desktop flash on
  // a phone) since Mako is a client-rendered SPA.
  return useMediaQuery(theme.breakpoints.down("md"), { noSsr: true });
}

export default useIsMobile;
