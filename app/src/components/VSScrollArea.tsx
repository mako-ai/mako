/**
 * VS Code-style overlay scrolling for ordinary containers.
 *
 * The point is the gutter: a styled native scrollbar is a CLASSIC scrollbar
 * and reserves layout space, so a selected row's highlight stops 10px short
 * of the container's edge. Monaco and xterm solve this with a scrollbar
 * WIDGET floating over the content (VS Code's ScrollableElement); this is
 * the same pattern for the rest of the app, via OverlayScrollbars: the
 * native bar is removed entirely (content reaches the edge) and a themed
 * thumb is drawn on top, appearing on hover or while scrolling.
 *
 * - Plain containers: render <VSScrollArea> instead of an overflow Box.
 * - Foreign scrollers (MUI DataGrid's virtualScroller): call
 *   attachOverlayScrollbars(el) — viewport-mode init, no DOM restructuring,
 *   so virtualization keeps reading scrollTop from its own element.
 *
 * The `os-theme-mako` skin lives in ThemeContext's CssBaseline overrides so
 * its colors track the palette.
 */
import { type CSSProperties, type ReactNode } from "react";
import { OverlayScrollbars, type PartialOptions } from "overlayscrollbars";
import { OverlayScrollbarsComponent } from "overlayscrollbars-react";
import "overlayscrollbars/overlayscrollbars.css";

const OPTIONS: PartialOptions = {
  scrollbars: {
    theme: "os-theme-mako",
    autoHide: "leave",
    autoHideDelay: 800,
    clickScroll: true,
  },
};

export default function VSScrollArea({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <OverlayScrollbarsComponent
      defer
      className={className}
      style={style}
      options={OPTIONS}
    >
      {children}
    </OverlayScrollbarsComponent>
  );
}

/**
 * Overlay scrollbars on an element some other library owns and scrolls.
 * Returns a destroy function; safe to call on the same element again after
 * destroying.
 */
export function attachOverlayScrollbars(target: HTMLElement): () => void {
  const instance = OverlayScrollbars(
    { target, elements: { viewport: target } },
    OPTIONS,
  );
  return () => instance.destroy();
}
