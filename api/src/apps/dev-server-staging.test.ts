/**
 * Staged binding files are replaced whole. The dev server serves them while a
 * reattach restages them in the background, so an in-place write let a page
 * reload read half a parquet ("No magic bytes found at end of file", INTL
 * Sales Dashboard, 2026-10-08). Real files, real `mv`.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stageFileAtomically } from "./dev-server.service";

type Provider = Parameters<typeof stageFileAtomically>[0];
const ctx = { sessionKey: "test" };

function localProvider(onWritten?: () => void): Provider {
  return {
    async writeFile(_ctx: unknown, file: string, bytes: Uint8Array) {
      writeFileSync(file, bytes);
      onWritten?.();
    },
    async exec(_ctx: unknown, command: string) {
      try {
        execSync(command, { stdio: "pipe" });
        return { exitCode: 0, stdout: "", stderr: "" };
      } catch (error) {
        const e = error as { status: number; stderr: Buffer };
        return { exitCode: e.status, stdout: "", stderr: String(e.stderr) };
      }
    },
  } as unknown as Provider;
}

describe("stageFileAtomically", () => {
  it("never exposes a partial file at the served path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mako-stage-"));
    const target = path.join(dir, "intl_calls_2026_q4.parquet");
    writeFileSync(target, "PAR1 old PAR1");
    writeFileSync(path.join(dir, "intl_calls_2026_q4.live"), "1");
    let servedMidWrite = "";

    await stageFileAtomically(
      localProvider(() => (servedMidWrite = readFileSync(target, "utf8"))),
      ctx,
      target,
      new TextEncoder().encode("PAR1 new PAR1"),
      `rm -f ${path.join(dir, "intl_calls_2026_q4.live")}`,
    );

    expect(servedMidWrite).toBe("PAR1 old PAR1");
    expect(readFileSync(target, "utf8")).toBe("PAR1 new PAR1");
    expect(existsSync(`${target}.staging`)).toBe(false);
    expect(existsSync(path.join(dir, "intl_calls_2026_q4.live"))).toBe(false);
  });

  it("fails loudly when the rename fails, rather than serving stale data", async () => {
    const provider = {
      async writeFile() {},
      async exec() {
        return { exitCode: 1, stdout: "", stderr: "mv: Permission denied\n" };
      },
    } as unknown as Provider;
    await expect(
      stageFileAtomically(provider, ctx, "/tmp/x.parquet", new Uint8Array()),
    ).rejects.toThrow("Could not stage /tmp/x.parquet: mv: Permission denied");
  });
});
