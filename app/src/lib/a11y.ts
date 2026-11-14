import type { KeyboardEvent } from "react";

/**
 * Props that make a clickable non-button element (Box, div, Typography)
 * reachable and operable from the keyboard: focusable, announced as a
 * button, activated by Enter or Space like a native button.
 *
 * Prefer a real button (ButtonBase / ListItemButton) for new UI; this is for
 * existing layouts where swapping the element would change styling.
 */
export function clickableProps(onActivate: () => void, label?: string) {
  return {
    role: "button" as const,
    tabIndex: 0,
    ...(label ? { "aria-label": label } : {}),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate();
      }
    },
  };
}
