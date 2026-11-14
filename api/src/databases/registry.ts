import { DatabaseDriver, DatabaseDriverMetadata } from "./driver";

class DatabaseRegistry {
  private drivers: Map<string, DatabaseDriver> = new Map();

  register(driver: DatabaseDriver) {
    const meta = driver.getMetadata();
    this.drivers.set(meta.type, driver);
  }

  getDriver(type: string): DatabaseDriver | undefined {
    return this.drivers.get(type);
  }

  /**
   * The registered driver for `type`, registering `create()` first when
   * there is none. Use this wherever a driver instance owns state (pools,
   * connectors, running-query maps): every caller — the API's startup
   * registration and the connection service alike — then shares ONE
   * instance, so a pool opened through one path is closed and a query
   * started through one path is cancelled by the other.
   */
  getOrRegister<T extends DatabaseDriver>(type: string, create: () => T): T {
    const existing = this.drivers.get(type);
    if (existing) return existing as T;
    const driver = create();
    this.drivers.set(type, driver);
    return driver;
  }

  getAllDrivers(): DatabaseDriver[] {
    return Array.from(this.drivers.values());
  }

  getAllMetadata(): DatabaseDriverMetadata[] {
    return Array.from(this.drivers.values()).map(d => d.getMetadata());
  }
}

export const databaseRegistry = new DatabaseRegistry();
