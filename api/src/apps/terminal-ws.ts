/**
 * Interactive terminal for Apps, over a WebSocket.
 *
 * The old terminal ran one command and printed the result. That is fine for
 * `ls`, and useless for everything a shell is actually for: a prompt, ctrl-C,
 * watching a build, an editor, anything that asks a question. This attaches a
 * real PTY in the sandbox and streams it, so the pane behaves like a terminal
 * because it IS one.
 *
 * Bytes both ways, no framing of our own — xterm.js and the shell already
 * agree on a protocol, and inventing a second one on top would only be
 * something else to get wrong. The single exception is window size, which has
 * no in-band representation: those arrive as a small JSON control message.
 *
 * A WebSocket upgrade has to be caught on the raw http.Server before Hono sees
 * it, the same way the old dev-preview proxy did. Unlike that proxy, nothing
 * of the tenant's runs here — this process only moves bytes between a socket
 * and a microVM.
 *
 * The implementation lives in `./terminal/`; this barrel keeps the import
 * path:
 *
 *   attach.ts    the WebSocket upgrade: path, auth, attach
 *   sessions.ts  live shells that outlive their socket: scrollback,
 *                history replay, reattach, kill
 *   start.ts     starting (or adopting) a shell in the sandbox
 */
export { attachAppsTerminalWs } from "./terminal/attach";
export {
  forgetTerminalCaches,
  killTerminalSession,
  killAllTerminalSessions,
} from "./terminal/sessions";
