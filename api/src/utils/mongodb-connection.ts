import { Db } from "mongodb";
import dotenv from "dotenv";
import { DatabaseConnection } from "../database/workspace-schema";
import { databaseConnectionService } from "../services/database-connection.service";

dotenv.config({ path: "../../.env" });

export interface MongoConfig {
  connectionString: string;
  database: string;
}

class MongoDBConnection {
  private static instance: MongoDBConnection;

  private constructor() {}

  public static getInstance(): MongoDBConnection {
    if (!MongoDBConnection.instance) {
      MongoDBConnection.instance = new MongoDBConnection();
    }
    return MongoDBConnection.instance;
  }

  /**
   * Get a database connection by database ID
   */
  public async getDatabase(databaseId: string): Promise<Db> {
    // Get the database config from Database model
    const dbRecord = await DatabaseConnection.findById(databaseId);

    if (!dbRecord) {
      throw new Error(`Database '${databaseId}' not found in configuration`);
    }

    if (!dbRecord.connection.connectionString) {
      throw new Error(`Database '${databaseId}' is missing connection string`);
    }

    console.log(
      `🔌 Getting MongoDB connection for '${databaseId}': ${dbRecord.connection.database || "default"} on ${dbRecord.name}`,
    );

    // Use unified pool to get connection
    const connection = await databaseConnectionService.getConnectionById(
      "datasource",
      databaseId,
      async id => {
        const ds = await DatabaseConnection.findById(id);
        if (!ds || !ds.connection.connectionString) return null;
        return {
          connectionString: ds.connection.connectionString,
          database: ds.connection.database || "",
        };
      },
    );

    console.log(`✅ Got connection for MongoDB '${databaseId}'`);

    return connection.db;
  }

  /**
   * Disconnect from a specific database
   * Note: With unified pool, this is a no-op as connections are managed by the pool
   */
  public async disconnect(databaseId: string): Promise<void> {
    console.log(`Disconnect requested for '${databaseId}' - handled by pool`);
  }

  /**
   * Disconnect from all databases
   * Note: With unified pool, this is a no-op as connections are managed by the pool
   */
  public async disconnectAll(): Promise<void> {
    console.log("Disconnect all requested - handled by pool");
  }
}

export const mongoConnection = MongoDBConnection.getInstance();
