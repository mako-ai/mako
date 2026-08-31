/** Tiny argv parser: `mako <command> [positional…] [--flag[=value]]`. */
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
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out.flags[arg.slice(2)] = next;
          i++;
        } else {
          out.flags[arg.slice(2)] = true;
        }
      }
    } else if (out.command === null) {
      out.command = arg;
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}
