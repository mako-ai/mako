import {
  createElement,
  lazy,
  Suspense,
  type ComponentType,
  type JSX,
  type ReactNode,
} from "react";
import { TabBodyLoading } from "../components/TabBodyLoading";

/**
 * React.lazy plus its own Suspense boundary, so a heavy tab body (xterm,
 * DataGridPremium, notebooks, dbt, settings) is split out of the entry chunk
 * without every call site having to add a boundary.
 */
export function lazyWithSuspense<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  fallback: ReactNode = createElement(TabBodyLoading),
): (props: P) => JSX.Element {
  const Lazy = lazy(load);
  function LazyWithSuspense(props: P) {
    return createElement(
      Suspense,
      { fallback },
      createElement(Lazy as ComponentType<P>, props),
    );
  }
  return LazyWithSuspense;
}
