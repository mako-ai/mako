import { Client, type ConnectConfig } from "ssh2";
import net from "net";
import { getLogger } from "../logging";

const logger = getLogger(["ssh-tunnel"]);

export interface SshTunnelConfig {
  /** Caller-provided cache key (e.g. `${databaseId}:${dbName}`) */
  key: string;
  sshHost: string;
  sshPort?: number;
  sshUsername: string;
  authMethod: "password" | "privateKey";
  sshPassword?: string;
  privateKey?: string;
  passphrase?: string;
  /** Remote host the tunnel forwards to (e.g. `127.0.0.1` on the bastion) */
  remoteHost: string;
  /** Remote port the tunnel forwards to (e.g. `3306`) */
  remotePort: number;
  /** Timeout in ms for the SSH handshake. Defaults to 15 000. */
  readyTimeoutMs?: number;
}

export interface TunnelEndpoint {
  host: string;
  port: number;
}

interface ActiveTunnel {
  endpoint: TunnelEndpoint;
  client: Client;
  server: net.Server;
  lastUsed: number;
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const IDLE_EXPIRY_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

class SshTunnelManager {
  private tunnels = new Map<string, ActiveTunnel>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Open (or reuse) an SSH tunnel. Returns a local endpoint that forwards
   * traffic to `remoteHost:remotePort` through the SSH bastion.
   */
  async openTunnel(config: SshTunnelConfig): Promise<TunnelEndpoint> {
    const existing = this.tunnels.get(config.key);
    if (existing) {
      existing.lastUsed = Date.now();
      logger.debug("Reusing SSH tunnel", {
        key: config.key,
        endpoint: existing.endpoint,
      });
      return existing.endpoint;
    }

    this.ensureSweep();

    const client = new Client();

    const connectConfig: ConnectConfig = {
      host: config.sshHost,
      port: config.sshPort ?? 22,
      username: config.sshUsername,
      readyTimeout: config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    };

    if (config.authMethod === "privateKey" && config.privateKey) {
      connectConfig.privateKey = config.privateKey;
      if (config.passphrase) connectConfig.passphrase = config.passphrase;
    } else if (config.sshPassword) {
      connectConfig.password = config.sshPassword;
      connectConfig.tryKeyboard = true;
    }

    logger.info("SSH connecting", {
      key: config.key,
      host: connectConfig.host,
      port: connectConfig.port,
      username: connectConfig.username,
      authMethod: config.authMethod,
    });

    await new Promise<void>((resolve, reject) => {
      client.on("ready", resolve);
      client.on("error", err => {
        logger.error("SSH client error", {
          key: config.key,
          error: err.message,
        });
        reject(err);
      });
      if (config.sshPassword) {
        const sshPassword = config.sshPassword;
        client.on(
          "keyboard-interactive",
          (_name, _instructions, _lang, prompts, finish) => {
            finish(prompts.map(() => sshPassword));
          },
        );
      }
      client.connect(connectConfig);
    });

    const server = net.createServer(socket => {
      client.forwardOut(
        socket.remoteAddress || "127.0.0.1",
        socket.remotePort || 0,
        config.remoteHost,
        config.remotePort,
        (err, stream) => {
          if (err) {
            logger.error("SSH forwardOut failed", {
              key: config.key,
              error: err.message,
            });
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
        },
      );
    });

    const localPort = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") {
          resolve(addr.port);
        } else {
          reject(new Error("Failed to bind local tunnel port"));
        }
      });
      server.on("error", reject);
    });

    const endpoint: TunnelEndpoint = { host: "127.0.0.1", port: localPort };
    this.tunnels.set(config.key, {
      endpoint,
      client,
      server,
      lastUsed: Date.now(),
    });

    logger.info("SSH tunnel opened", {
      key: config.key,
      localPort,
      remote: `${config.remoteHost}:${config.remotePort}`,
    });

    client.on("end", () => this.removeTunnel(config.key));
    client.on("close", () => this.removeTunnel(config.key));

    return endpoint;
  }

  /** Retrieve the endpoint for an existing tunnel without touching lastUsed. */
  getTunnel(key: string): TunnelEndpoint | null {
    return this.tunnels.get(key)?.endpoint ?? null;
  }

  /** Explicitly close a tunnel by key. */
  async closeTunnel(key: string): Promise<void> {
    const tunnel = this.tunnels.get(key);
    if (!tunnel) return;
    this.destroyTunnel(key, tunnel);
  }

  /** Close every open tunnel. Called during graceful shutdown. */
  async closeAll(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const [key, tunnel] of this.tunnels) {
      this.destroyTunnel(key, tunnel);
    }
  }

  private removeTunnel(key: string) {
    const tunnel = this.tunnels.get(key);
    if (!tunnel) return;
    this.destroyTunnel(key, tunnel);
  }

  private destroyTunnel(key: string, tunnel: ActiveTunnel) {
    this.tunnels.delete(key);
    try {
      tunnel.server.close();
    } catch {
      /* ignore */
    }
    try {
      tunnel.client.end();
    } catch {
      /* ignore */
    }
    logger.info("SSH tunnel closed", { key });
  }

  private ensureSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  private sweep() {
    const now = Date.now();
    for (const [key, tunnel] of this.tunnels) {
      if (now - tunnel.lastUsed > IDLE_EXPIRY_MS) {
        logger.info("Evicting idle SSH tunnel", { key });
        this.destroyTunnel(key, tunnel);
      }
    }
    if (this.tunnels.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}

export const sshTunnelManager = new SshTunnelManager();
