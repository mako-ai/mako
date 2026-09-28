/**
 * Flags that never take a value: `--full-refresh -s stg_orders` must not read
 * `-s` as the value of `--full-refresh`. Every other long flag takes the next
 * token as its value unless that token is itself a flag (starts with "-").
 * `--no-<flag>` sets a flag to false; `--flag=value` always carries a value.
 */
export const BOOLEAN_FLAGS = new Set([
  "help",
  "open",
  "json",
  "browser",
  "defer",
  "full-refresh",
  "warehouse-write",
]);

const takesValue = next => next !== undefined && !next.startsWith("-");

/** Tiny argv parser: `mako <command> [positional…] [--flag[=value]] [-f value]`. */
export function parseArgs(argv) {
  const out = { command: null, positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        out.flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (arg.startsWith("--no-")) {
        out.flags[arg.slice(5)] = false;
      } else {
        const name = arg.slice(2);
        if (!BOOLEAN_FLAGS.has(name) && takesValue(argv[i + 1])) {
          out.flags[name] = argv[++i];
        } else {
          out.flags[name] = true;
        }
      }
    } else if (/^-[A-Za-z]$/.test(arg)) {
      // Short flag (`-s stg_orders`): takes a value unless a flag follows.
      if (takesValue(argv[i + 1])) {
        out.flags[arg.slice(1)] = argv[++i];
      } else {
        out.flags[arg.slice(1)] = true;
      }
    } else if (out.command === null) {
      out.command = arg;
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}
