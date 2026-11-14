/**
 * Shared Prism highlighter for chat code blocks and tool cards.
 *
 * The full `Prism` export of react-syntax-highlighter registers every
 * refractor grammar (~300, hundreds of KB) into the entry chunk. PrismLight
 * with the handful of languages the chat actually shows keeps that out;
 * anything else renders as plain text.
 */
// The package is sideEffects:false, so the unused builds the index
// re-exports (full Prism, highlight.js) are tree-shaken away.
import { PrismLight } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import graphql from "react-syntax-highlighter/dist/esm/languages/prism/graphql";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";

const LANGUAGES: Record<string, unknown> = {
  bash,
  sh: bash,
  shell: bash,
  zsh: bash,
  css,
  diff,
  graphql,
  javascript,
  js: javascript,
  // Mongo shell queries are JavaScript.
  mongodb: javascript,
  json,
  jsx,
  markdown,
  md: markdown,
  markup,
  html: markup,
  xml: markup,
  python,
  py: python,
  sql,
  postgresql: sql,
  mysql: sql,
  tsx,
  typescript,
  ts: typescript,
  yaml,
  yml: yaml,
};

for (const [name, grammar] of Object.entries(LANGUAGES)) {
  PrismLight.registerLanguage(name, grammar);
}

export { PrismLight as SyntaxHighlighter };
