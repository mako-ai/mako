#!/usr/bin/env node
import { main } from "../src/main.js";

main(process.argv.slice(2)).then(
  code => process.exit(code ?? 0),
  error => {
    console.error(`mako: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
