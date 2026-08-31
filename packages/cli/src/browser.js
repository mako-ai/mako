import { spawn } from "node:child_process";

/** Best-effort: open a URL in the default browser; false when we couldn't. */
export function openInBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
