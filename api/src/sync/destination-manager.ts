import { Db, ObjectId } from "mongodb";
import * as crypto from "crypto";
import * as dotenv from "dotenv";
import { databaseConnectionService } from "../services/database-connection.service";

dotenv.config();

// Database-based destination manager for app destinations
export class DatabaseDestinationManager {
  private databaseName: string = "";
  private initialized = false;

  private initialize() {
    if (this.initialized) return;

    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    const connectionString = process.env.DATABASE_URL;

    // Extract database name from the connection string or use environment variable
    this.databaseName =
      process.env.DATABASE_NAME ||
      this.extractDatabaseName(connectionString) ||
      "mako";

    this.initialized = true;
  }

  private extractDatabaseName(connectionString: string): string | null {
    try {
      const url = new URL(connectionString);
      const pathname = url.pathname;
      if (pathname && pathname.length > 1) {
        return pathname.substring(1); // Remove leading slash
      }
    } catch {
      // Invalid URL, return null
    }
    return null;
  }

  private async getDb(): Promise<Db> {
    this.initialize();

    // Use the unified pool to get the main database connection
    const connection = await databaseConnectionService.getMainConnection();

    return connection.db;
  }

  async getDestination(id: string): Promise<any> {
    const db = await this.getDb();
    const collection = db.collection("databaseconnections");

    if (!ObjectId.isValid(id)) {
      return null;
    }

    // Try to find by name first, then by ID
    const destination = await collection.findOne({
      _id: new ObjectId(id),
    });

    if (!destination) {
      return null;
    }

    // Return in the expected format for the sync service
    return {
      id: destination._id,
      name: destination.name,
      type: "mongodb",
      connection: {
        connection_string: this.decryptString(
          destination.connection.connectionString,
        ),
        database: this.decryptString(destination.connection.database),
      },
    };
  }

  async listDestinations(
    workspaceId: string,
  ): Promise<{ name: string; id: string }[]> {
    const db = await this.getDb();
    const collection = db.collection("databaseconnections");
    const destinations = await collection
      .find(
        { workspaceId: new ObjectId(workspaceId) },
        { projection: { name: 1, _id: 1 } },
      )
      .toArray();
    return destinations.map(d => ({ name: d.name, id: d._id.toString() }));
  }

  async listWorkspaces(): Promise<{ name: string; id: string }[]> {
    const db = await this.getDb();
    const collection = db.collection("workspaces");
    const workspaces = await collection
      .find({}, { projection: { name: 1, _id: 1 } })
      .toArray();
    return workspaces.map(w => ({ name: w.name, id: w._id.toString() }));
  }

  private decryptString(encryptedString: string): string {
    // Get encryption key from environment
    const encryptionKey = process.env.ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error("ENCRYPTION_KEY environment variable is not set");
    }

    // Parse the encrypted string (format: iv:encrypted_data)
    const textParts = encryptedString.split(":");
    if (textParts.length !== 2) {
      throw new Error("Invalid encrypted string format");
    }

    const iv = Buffer.from(textParts[0], "hex");
    const encryptedText = Buffer.from(textParts[1], "hex");

    // Decrypt using AES-256-CBC
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      Buffer.from(encryptionKey, "hex"),
      iv,
    );

    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString();
  }
}

// Lazy-initialized singleton
let databaseDestinationManagerInstance: DatabaseDestinationManager | null =
  null;

export function getDestinationManager() {
  if (!databaseDestinationManagerInstance) {
    databaseDestinationManagerInstance = new DatabaseDestinationManager();
  }
  return databaseDestinationManagerInstance;
}
