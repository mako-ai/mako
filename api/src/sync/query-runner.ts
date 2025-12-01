import { Db } from "mongodb";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { DatabaseConnection } from "../database/workspace-schema";
import { databaseConnectionService } from "../services/database-connection.service";

dotenv.config();

class QueryRunner {
  private currentDataSource: string | null = null;

  constructor() {
    // Initialize with primary database
    void this.initializePrimaryDatabase();
  }

  private async initializePrimaryDatabase() {
    try {
      const databases = await DatabaseConnection.find({})
        .sort({ createdAt: -1 })
        .limit(1);
      if (databases.length > 0) {
        this.currentDataSource = databases[0]._id.toString();
      }
    } catch (error) {
      console.error("Failed to initialize primary database:", error);
    }
  }

  private async getConnection(dataSourceId?: string): Promise<{ db: Db }> {
    const sourceId = dataSourceId || this.currentDataSource;

    if (!sourceId) {
      throw new Error(
        "No data source specified and no default data source available. Please specify a data source ID or add a database to your workspace.",
      );
    }

    // Get data source configuration
    const dataSource = await DatabaseConnection.findById(sourceId);
    if (!dataSource) {
      throw new Error(`MongoDB data source '${sourceId}' not found`);
    }

    // Use unified pool to get connection
    const connection = await databaseConnectionService.getConnectionById(
      "datasource",
      sourceId,
      async id => {
        const ds = await DatabaseConnection.findById(id);
        if (!ds || !ds.connection.connectionString) return null;
        return {
          connectionString: ds.connection.connectionString,
          database: ds.connection.database || "",
        };
      },
    );

    console.log(`Connected to MongoDB: ${dataSource.name}`);
    return { db: connection.db };
  }

  async executeQuery(
    queryFilePath: string,
    dataSourceId?: string,
  ): Promise<any[]> {
    try {
      const { db } = await this.getConnection(dataSourceId);

      // Read the query file
      const absolutePath = path.isAbsolute(queryFilePath)
        ? queryFilePath
        : path.join(process.cwd(), queryFilePath);

      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Query file not found: ${absolutePath}`);
      }

      const queryContent = fs.readFileSync(absolutePath, "utf8");

      // Parse the MongoDB aggregation pipeline
      let pipeline;
      try {
        // Remove any JavaScript comments and parse
        const cleanedQuery = queryContent.replace(/\/\/.*$/gm, "").trim();
        pipeline = JSON.parse(cleanedQuery);
      } catch (parseError) {
        throw new Error(`Failed to parse query JSON: ${parseError}`);
      }

      // Ensure pipeline is an array
      if (!Array.isArray(pipeline)) {
        pipeline = [pipeline];
      }

      // Extract collection name from the first stage if it's a $from stage
      let collectionName = "data"; // default collection name
      if (
        pipeline.length > 0 &&
        pipeline[0].$from &&
        typeof pipeline[0].$from === "string"
      ) {
        collectionName = pipeline[0].$from;
        pipeline.shift(); // Remove the $from stage
      }

      console.log(`Executing query on collection: ${collectionName}`);
      console.log(
        `Using data source: ${dataSourceId || this.currentDataSource || "none"}`,
      );

      // Execute the aggregation pipeline
      const collection = db.collection(collectionName);
      const results = await collection.aggregate(pipeline).toArray();

      console.log(`Query returned ${results.length} results`);
      return results;
    } catch (error) {
      console.error("Query execution failed:", error);
      throw error;
    }
  }

  async listCollections(dataSourceId?: string): Promise<string[]> {
    try {
      const { db } = await this.getConnection(dataSourceId);
      const collections = await db.listCollections().toArray();
      return collections.map(col => col.name);
    } catch (error) {
      console.error("Failed to list collections:", error);
      throw error;
    }
  }

  async getCollectionStats(
    collectionName: string,
    dataSourceId?: string,
  ): Promise<any> {
    try {
      const { db } = await this.getConnection(dataSourceId);
      const stats = await db.command({ collStats: collectionName });
      return stats;
    } catch (error) {
      console.error("Failed to get collection stats:", error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // No need to explicitly disconnect - connections are managed by the pool
    console.log("Query runner cleanup complete (connections managed by pool)");
  }

  /**
   * List all available MongoDB data sources
   */
  async listAvailableDataSources(): Promise<
    {
      id: string;
      name: string;
      description?: string;
    }[]
  > {
    try {
      const databases = await DatabaseConnection.find({}).sort({
        createdAt: -1,
      });
      return databases.map(db => ({
        id: db._id.toString(),
        name: db.name,
        description: "",
      }));
    } catch (error) {
      console.error("Failed to list data sources:", error);
      return [];
    }
  }

  /**
   * Switch the default data source for queries
   */
  async setDefaultDataSource(dataSourceId: string): Promise<void> {
    const source = await DatabaseConnection.findById(dataSourceId);
    if (!source) {
      throw new Error(`MongoDB data source '${dataSourceId}' not found`);
    }
    this.currentDataSource = dataSourceId;
    console.log(`Default data source set to: ${source.name}`);
  }
}

export default QueryRunner;
