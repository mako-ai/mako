/**
 * Bundles the Mako Local Agent into a single standalone JS file
 * (dist/index.js) runnable with plain `node` — used by the packaged desktop
 * app (extraResources/agent) and standalone agent distribution.
 *
 * The agent reuses api/src sources, so the bundle inlines those plus their
 * npm dependencies. Optional native add-ons that the database drivers probe
 * for at runtime are stubbed: every one of them has a pure-JS fallback path.
 */
import { build } from "esbuild";
import { fileURLToPath } from "url";
import path from "path";

const root = path.dirname(fileURLToPath(import.meta.url));

// Optional/native modules probed via require() at runtime. Marking them as
// empty stubs keeps the bundle pure-JS; the owning libraries catch the error
// and fall back (e.g. pg-native -> JS protocol, ssh2 crypto binding -> JS).
const OPTIONAL_STUBS = [
  "pg-native",
  "cpu-features",
  "./crypto/build/Release/sshcrypto.node",
  "kerberos",
  "@mongodb-js/zstd",
  "@aws-sdk/credential-providers",
  "mongodb-client-encryption",
  "snappy",
  "socks",
  "aws4",
  "gcp-metadata",
];

const stubPlugin = {
  name: "optional-native-stubs",
  setup(buildApi) {
    for (const mod of OPTIONAL_STUBS) {
      const filter = new RegExp(
        `^${mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      );
      buildApi.onResolve({ filter }, args => ({
        path: args.path,
        namespace: "optional-stub",
      }));
    }
    buildApi.onLoad({ filter: /.*/, namespace: "optional-stub" }, () => ({
      contents: "module.exports = {};",
      loader: "js",
    }));
  },
};

await build({
  entryPoints: [path.join(root, "src/index.ts")],
  outfile: path.join(root, "dist/index.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: false,
  logLevel: "info",
  plugins: [stubPlugin],
  // Mongoose lazy-requires its browser build; irrelevant under node.
  external: ["./browser"],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});
