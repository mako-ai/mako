export interface ConsoleVersion {
  id: string;
  content: string;
  timestamp: Date;
  source: "user" | "ai";
  description?: string;
  aiPrompt?: string;
  aiComment?: string;
  aiCommentStatus?: "pending" | "done" | "failed";
}

export interface VersionHistory {
  id: string;
  content: string;
  timestamp: Date;
  source: "user" | "ai";
  description?: string;
  aiComment?: string;
  aiCommentStatus?: "pending" | "done" | "failed";
  isCurrent: boolean;
}

const STORAGE_KEY_PREFIX = "console_version_history_";
const MAX_VERSIONS = 50;

export class ConsoleVersionManager {
  private versions: ConsoleVersion[] = [];
  private currentIndex = -1;
  private storageKey: string;

  constructor(consoleId: string) {
    this.storageKey = STORAGE_KEY_PREFIX + consoleId;
    this.loadFromStorage();
  }

  saveVersion(
    content: string,
    source: "user" | "ai",
    description?: string,
    aiPrompt?: string,
  ): string {
    // Remove any versions after the current index (for redo functionality)
    if (this.currentIndex < this.versions.length - 1) {
      this.versions = this.versions.slice(0, this.currentIndex + 1);
    }

    const newVersion: ConsoleVersion = {
      id: `v_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      content,
      timestamp: new Date(),
      source,
      description,
      aiPrompt,
    };

    this.versions.push(newVersion);

    // Limit the number of versions
    if (this.versions.length > MAX_VERSIONS) {
      this.versions = this.versions.slice(-MAX_VERSIONS);
    }

    this.currentIndex = this.versions.length - 1;
    this.persistToStorage();
    return newVersion.id;
  }

  updateVersion(id: string, patch: Partial<ConsoleVersion>): boolean {
    const version = this.versions.find(v => v.id === id);
    if (!version) return false;
    Object.assign(version, patch);
    this.persistToStorage();
    return true;
  }

  getPreviousContent(id: string): string | null {
    const index = this.versions.findIndex(v => v.id === id);
    if (index <= 0) return null;
    return this.versions[index - 1].content;
  }

  undo(): string | null {
    if (!this.canUndo()) return null;

    this.currentIndex--;
    this.persistToStorage();
    return this.versions[this.currentIndex].content;
  }

  redo(): string | null {
    if (!this.canRedo()) return null;

    this.currentIndex++;
    this.persistToStorage();
    return this.versions[this.currentIndex].content;
  }

  canUndo(): boolean {
    return this.currentIndex > 0;
  }

  canRedo(): boolean {
    return this.currentIndex < this.versions.length - 1;
  }

  getHistory(): VersionHistory[] {
    return this.versions.map((version, index) => ({
      ...version,
      isCurrent: index === this.currentIndex,
    }));
  }

  restoreVersion(id: string): string | null {
    const index = this.versions.findIndex(v => v.id === id);
    if (index === -1) return null;

    this.currentIndex = index;
    this.persistToStorage();
    return this.versions[index].content;
  }

  getCurrentVersion(): ConsoleVersion | null {
    if (this.currentIndex === -1 || this.currentIndex >= this.versions.length) {
      return null;
    }
    return this.versions[this.currentIndex];
  }

  clear(): void {
    this.versions = [];
    this.currentIndex = -1;
    this.persistToStorage();
  }

  private persistToStorage(): void {
    try {
      const data = {
        versions: this.versions,
        currentIndex: this.currentIndex,
      };
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (error) {
      console.error("Failed to persist version history:", error);
    }
  }

  private loadFromStorage(): void {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        const data = JSON.parse(stored);
        if (data.versions && Array.isArray(data.versions)) {
          this.versions = data.versions.map((v: any) => ({
            ...v,
            timestamp: new Date(v.timestamp),
          }));
          this.currentIndex = data.currentIndex ?? this.versions.length - 1;
        }
      }
    } catch (error) {
      console.error("Failed to load version history:", error);
      this.clear();
    }
  }

  cleanup(): void {
    try {
      localStorage.removeItem(this.storageKey);
    } catch (error) {
      console.error("Failed to cleanup version history:", error);
    }
  }
}
