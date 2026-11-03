These components come from the [shadcn/ui Base UI registry](https://ui.shadcn.com/docs/ai-elements) (`base-nova`, retrieved 2026-10-14). The MIT license is in `LICENSE.shadcn`.

Mako uses local imports and its existing Tailwind theme tokens. Trace content collapses without animation so Virtuoso can keep the streaming tail in view. Collapsed content unmounts. Input Group uses an explicit disabled state so an empty Send button does not dim the composer.

Chat keeps its existing Virtuoso scroller, streaming transport, tool dispatch, approval controls, and model selection. These primitives only provide presentation and accessible controls.

Base UI is pinned to 1.8.0. Run the chat tests and browser checks when you upgrade it.
