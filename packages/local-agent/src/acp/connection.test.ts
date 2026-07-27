import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { terminateAdapterProcess } from "./connection";

test(
  "terminateAdapterProcess escalates when an adapter ignores SIGTERM",
  { skip: process.platform === "win32", timeout: 5000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          'process.on("SIGTERM", () => {});',
          'process.stdout.write("ready\\n");',
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout?.once("data", () => resolve());
    });

    await terminateAdapterProcess(child, 20);

    assert.equal(child.signalCode, "SIGKILL");
  },
);
