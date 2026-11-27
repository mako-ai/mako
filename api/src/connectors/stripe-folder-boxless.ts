/**
 * The Stripe folder as `SandboxedConnector` runs it, with only the box
 * replaced by a local process. Shared by stripe-folder.test.ts and
 * stripe-folder-reads.test.ts.
 */
import { SandboxedConnector } from "./workspace/SandboxedConnector";
import type { LoadedConnector } from "./workspace/resolver";
import type { ConnectorCommand, RunResult } from "./workspace/sync-box";
import {
  runFolderCommand,
  type StripeTestConfig,
} from "../../../connectors/stripe/fixtures/harness.mjs";

/**
 * The Stripe folder as a workspace connector, with the box swapped for a
 * local process running the same SDK runner on the same files. Everything
 * else is `SandboxedConnector` as production runs it.
 */
export class BoxlessStripe extends SandboxedConnector {
  static spec: Record<string, any> | undefined;

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "stripe",
      runtime: "node",
      entry: "connector.ts",
      sha: "golden",
      sourceSha: "golden",
      spec: BoxlessStripe.spec,
      entities: Object.keys(BoxlessStripe.spec?.mako?.entities ?? {}),
      status: "indexed",
    } as LoadedConnector;
    return this.loaded;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
    const result = await runFolderCommand(command, options);
    return {
      exitCode: result.code ?? 1,
      messages: result.messages as RunResult["messages"],
      malformed: [],
      stderr: result.stderr,
      timedOut: false,
    };
  }
}

export const makeBoxed = (config: StripeTestConfig) =>
  new BoxlessStripe({
    id: "ds_golden",
    name: "Stripe golden",
    type: "ws:stripe",
    workspaceId: "ws_golden",
    config,
  } as any);
