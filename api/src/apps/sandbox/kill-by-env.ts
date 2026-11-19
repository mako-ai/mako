/**
 * Killing a command's processes inside a box by an env var they inherit.
 *
 * Its own module so the E2B provider and the publish build share it. By
 * environment, not by process tree: when a command's deadline passes, envd
 * kills only the top bash, and its children are reparented to init (measured
 * in a real box: 3 of 3 `sleep`s survived). They share envd's process group,
 * so a group kill would take envd down too. npm, vite and esbuild all inherit
 * the environment, and it survives the reparenting.
 */

/**
 * Shell that SIGKILLs every process whose environment holds `name=value`. A
 * STOP pass first, so nothing forks past the KILL pass. Run it as root: only
 * root reads every process's environ. Without /proc (macOS, the local
 * provider) it does nothing.
 */
export function killByEnvScript(name: string, value: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !/^[A-Za-z0-9-]+$/.test(value)) {
    throw new Error("killByEnvScript: unsafe name or value");
  }
  return `for s in STOP KILL; do for p in /proc/[0-9]*; do grep -qzx '${name}=${value}' "$p/environ" 2>/dev/null && kill -$s "\${p#/proc/}" 2>/dev/null; done; done; true`;
}
