/**
 * Cloud SQL driver pool/connector lifecycle (review-backend.md #1):
 *
 *  - pools are keyed `${id}:${db}`, and closeConnection(id) must close ALL
 *    of them (it used to look up the bare id and close nothing);
 *  - one Connector per connection id, shared by its pools (a new one per
 *    pool used to overwrite and orphan the previous one);
 *  - concurrent first calls share one pool;
 *  - idle pools (and then their Connector) are swept.
 *
 * The Connector is faked; the pools are real pg Pools that never connect
 * (pg connects lazily), so nothing touches the network.
 *
 * Run: tsx src/databases/drivers/cloudsql-postgres/driver.pools.test.ts
 */
import assert from "node:assert/strict";
import { CloudSQLPostgresDatabaseDriver } from "./driver";

type FakeConnector = {
  closed: number;
  getOptions: () => Promise<Record<string, unknown>>;
  close: () => void;
};

function fakeDriver() {
  const driver = new CloudSQLPostgresDatabaseDriver();
  const connectors: FakeConnector[] = [];
  (driver as any)._getConnector = async () => {
    // Yield, so concurrent callers really overlap the creation.
    await new Promise(resolve => setTimeout(resolve, 5));
    const connector: FakeConnector = {
      closed: 0,
      getOptions: async () => ({ host: "127.0.0.1", port: 1 }),
      close() {
        this.closed++;
      },
    };
    connectors.push(connector);
    return connector;
  };
  const pools = () =>
    (driver as any).pools as Map<string, { pool: any; lastUsed: number }>;
  return { driver, connectors, pools };
}

function connection(id: string): any {
  return {
    _id: { toString: () => id },
    type: "cloudsql-postgres",
    connection: { instanceConnectionName: "p:r:i", username: "u" },
  };
}

async function main() {
  const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const B = "bbbbbbbbbbbbbbbbbbbbbbbb";

  // Concurrent first calls → one pool, one connector.
  {
    const { driver, connectors, pools } = fakeDriver();
    const [p1, p2] = await Promise.all([
      driver.getConnection(connection(A)),
      driver.getConnection(connection(A)),
    ]);
    assert.equal(p1, p2, "concurrent first calls share one pool");
    assert.equal(pools().size, 1);
    assert.equal(connectors.length, 1);

    // A second database name gets its own pool but the SAME connector.
    const p3 = await driver.getConnection(connection(A), "analytics");
    assert.notEqual(p3, p1);
    assert.equal(pools().size, 2);
    assert.equal(connectors.length, 1, "one Connector per connection id");

    // Another connection is separate.
    await driver.getConnection(connection(B));
    assert.equal(connectors.length, 2);
    assert.equal(pools().size, 3);

    // closeConnection(id) closes every `${id}:*` pool and the connector —
    // and only that connection's.
    let ended = 0;
    for (const { pool } of pools().values()) {
      const end = pool.end.bind(pool);
      pool.end = async () => {
        ended++;
        return end();
      };
    }
    await driver.closeConnection(A);
    assert.equal(ended, 2, "both of A's pools are ended");
    assert.deepEqual([...pools().keys()], [`${B}:default`]);
    assert.equal(connectors[0].closed, 1, "A's connector is closed");
    assert.equal(connectors[1].closed, 0, "B's connector is untouched");

    // The next call after invalidation builds afresh.
    const fresh = await driver.getConnection(connection(A));
    assert.notEqual(fresh, p1);
    assert.equal(connectors.length, 3);

    await driver.closeAllConnections();
    assert.equal(pools().size, 0);
    assert.equal(connectors[1].closed, 1);
    assert.equal(connectors[2].closed, 1);
  }

  // closeConnection while a pool is still being created: it must not land
  // in the map afterwards.
  {
    const { driver, connectors, pools } = fakeDriver();
    const creating = driver.getConnection(connection(A));
    const closing = driver.closeConnection(A);
    await creating.catch(() => undefined);
    await closing;
    assert.equal(pools().size, 0, "an in-flight pool is closed, not kept");
    assert.equal(connectors[0].closed, 1);
  }

  // Idle sweep: an unused pool goes, and with it the now-unused connector.
  {
    const { driver, connectors, pools } = fakeDriver();
    await driver.getConnection(connection(A));
    await driver.getConnection(connection(B));
    const idle = pools().get(`${A}:default`);
    assert.ok(idle);
    idle.lastUsed = Date.now() - 60_000;
    await driver.cleanupIdleConnections(30_000);
    assert.deepEqual([...pools().keys()], [`${B}:default`]);
    assert.equal(connectors[0].closed, 1, "idle connection's connector closed");
    assert.equal(connectors[1].closed, 0);
    await driver.closeAllConnections();
  }

  // eslint-disable-next-line no-console
  console.log("cloudsql-postgres pool lifecycle tests passed");
}

main()
  .then(() => {
    // Pools and drivers can hold handles open; exit explicitly so this
    // CLI-style test (run via `tsx` in the api `test` script) never hangs CI.
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  })
  .catch(error => {
    console.error(error);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });
