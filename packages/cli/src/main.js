import { findCredential, removeCredential } from "@makoai/app-sdk/credentials";
import { parseArgs } from "./args.js";
import { loadContext } from "./context.js";
import { login } from "./login.js";
import { dev } from "./dev.js";
import { status } from "./status.js";

const HELP = `mako — Mako from your terminal

  mako login   [--api-url <url>] [--no-browser]   sign in once (OAuth, browser), for this workspace checkout
  mako logout                                     forget the stored credential for this host/workspace
  mako whoami                                     show which host/workspace you are signed in to
  mako dev     [<app>] [--port <n>] [--open]      run apps/<app> locally with real data
  mako status  [<app>]                            what is LIVE: published commit vs the tip of main

Run inside a workspace checkout; the host comes from --api-url, MAKO_API_URL,
the repo's .env, or defaults to https://app.mako.ai. An API key in .env
(MAKO_API_KEY) is used instead of a login when present.`;

export async function main(argv, io = { log: console.log }) {
  const { command, positional, flags } = parseArgs(argv);
  if (!command || command === "help" || flags.help) {
    io.log(HELP);
    return 0;
  }
  const ctx = loadContext(flags);
  switch (command) {
    case "login":
      return login(ctx, flags, io);
    case "logout": {
      const had = removeCredential(ctx.apiUrl, ctx.workspaceId);
      io.log(had ? `Signed out of ${ctx.apiUrl}.` : `Nothing stored for ${ctx.apiUrl}.`);
      return 0;
    }
    case "whoami": {
      const entry = findCredential(ctx.apiUrl, ctx.workspaceId);
      if (ctx.apiKey) io.log(`API key configured for ${ctx.apiUrl} (MAKO_API_KEY).`);
      if (entry) {
        io.log(`Signed in to ${entry.apiUrl}${entry.workspaceId ? ` / workspace ${entry.workspaceId}` : ""} (token expires ${entry.expiresAt ?? "?"}).`);
      } else if (!ctx.apiKey) {
        io.log(`Not signed in to ${ctx.apiUrl}. Run \`mako login\`.`);
        return 1;
      }
      return 0;
    }
    case "dev":
      return dev(ctx, positional, flags, io);
    case "status":
      return status(ctx, positional, io);
    default:
      io.log(`unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}
