import { SyncLogger } from "../connectors/base/BaseConnector";
import { loggers } from "../logging";

const logger = loggers.sync("progress");

// Progress reporter for sync operations
export class ProgressReporter {
  private startTime: Date;
  private totalRecords: number;
  private currentRecords: number = 0;
  private entityName: string;
  private logger?: SyncLogger;

  constructor(entityName: string, totalRecords?: number, logger?: SyncLogger) {
    this.entityName = entityName;
    this.totalRecords = totalRecords || 0;
    this.startTime = new Date();
    this.logger = logger;
  }

  updateTotal(total: number) {
    this.totalRecords = total;
  }

  reportBatch(batchSize: number) {
    this.currentRecords += batchSize;
    this.displayProgress();
  }

  reportProgress(current: number, total?: number) {
    this.currentRecords = current;
    if (total !== undefined && total !== this.totalRecords) {
      this.totalRecords = total;
    }
    this.displayProgress();
  }

  reportComplete() {
    this.currentRecords = this.totalRecords;
    this.displayProgress();
    logger.info(""); // New line after progress
  }

  private displayProgress() {
    const elapsed = Date.now() - this.startTime.getTime();
    const elapsedStr = this.formatTime(elapsed);

    if (this.totalRecords > 0) {
      // We know the total, show full progress
      let percentage = Math.floor(
        (this.currentRecords / this.totalRecords) * 100,
      );
      if (percentage > 100) percentage = 100; // clamp to 100%
      const progressBar = this.createProgressBar(percentage);

      // Only calculate and show remaining time if we have processed some records
      let remainingStr = "";
      if (this.currentRecords > 0 && elapsed > 0) {
        const rate = this.currentRecords / (elapsed / 1000); // records per second
        if (rate > 0) {
          const remaining =
            ((this.totalRecords - this.currentRecords) / rate) * 1000; // milliseconds
          remainingStr = ` | 🕒 ${this.formatTime(remaining)} left`;
        }
      }

      process.stdout.write(
        `\r🟢 Syncing ${this.entityName}: ${progressBar} ${percentage}% (${this.currentRecords.toLocaleString()}/${this.totalRecords.toLocaleString()}) | ⏱️  ${elapsedStr} elapsed${remainingStr}`,
      );
    } else {
      // We don't know the total, show records fetched
      process.stdout.write(
        `\r🟢 Syncing ${this.entityName}: ${this.currentRecords.toLocaleString()} records fetched | ⏱️  ${elapsedStr} elapsed`,
      );
    }
  }

  private createProgressBar(percentage: number): string {
    const width = 20;
    const filled = Math.min(width, Math.floor((width * percentage) / 100));
    const empty = Math.max(0, width - filled);
    return "█".repeat(filled) + "░".repeat(empty);
  }

  private formatTime(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
    } else if (minutes > 0) {
      return `${minutes}m${(seconds % 60).toString().padStart(2, "0")}s`;
    } else {
      return `${seconds}s`;
    }
  }
}
