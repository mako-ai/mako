import { cli } from "../api/src/scripts/drop-migrated-mongo-collections";

void cli(process.argv.slice(2), {
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
}).then(
  code => {
    process.exitCode = code;
  },
  error => {
    // Driver error messages can contain credentials.
    process.stderr.write(`${error instanceof Error ? error.name : "Error"}\n`);
    process.exitCode = 1;
  },
);
