/**
 * `ConsoleManager` — the historical class face of the console domain
 * service, kept so callers outside the consoles area (the agent's console
 * tools, the execute routes) need not change. Every member delegates to the
 * functions in this directory; new code should import those directly.
 */
import type { ISavedConsole } from "../../database/workspace-schema";
import {
  canReadConsole,
  canReadConsoleWithInheritance,
  canWriteConsole,
  isConsoleCollaborator,
  resolveConsoleAccess,
  resolveConsoleAccessWithInheritance,
} from "./access";
import {
  getConsoleWithMetadata,
  listConsoles,
  listConsolesFlat,
  listConsolesSplit,
} from "./tree";
import {
  createConsoleFolder,
  deleteConsoleFolder,
  ensureConsoleFolderPath,
  moveConsoleFolder,
  renameConsoleFolder,
} from "./folders";
import {
  duplicateConsole,
  getConsoleByPath,
  moveConsole,
  recordConsoleExternalUse,
  renameConsole,
  restoreConsole,
  saveConsole,
  softDeleteConsole,
  updateConsoleAccess,
} from "./crud";

export class ConsoleManager {
  static resolveAccess = resolveConsoleAccess;
  static isCollaborator = isConsoleCollaborator;
  static canRead = canReadConsole;

  /** Admins can write any workspace-level console. */
  static canWrite(
    console: ISavedConsole,
    userId: string,
    isAdmin: boolean = false,
    memberRole?: string,
  ): boolean {
    return canWriteConsole(
      console,
      userId,
      memberRole ?? (isAdmin ? "admin" : undefined),
    );
  }

  canReadWithInheritance = canReadConsoleWithInheritance;
  resolveAccessWithInheritance = resolveConsoleAccessWithInheritance;

  listConsoles = listConsoles;
  listConsolesFlat = listConsolesFlat;
  listConsolesSplit = listConsolesSplit;
  getConsoleWithMetadata = getConsoleWithMetadata;

  saveConsole = saveConsole;
  renameConsole = renameConsole;
  moveConsole = moveConsole;
  updateConsoleAccess = updateConsoleAccess;
  softDeleteConsole = softDeleteConsole;
  restoreConsole = restoreConsole;
  duplicateConsole = duplicateConsole;
  getConsoleByPath = getConsoleByPath;
  recordExternalUse = recordConsoleExternalUse;

  findOrCreateFolderPath = ensureConsoleFolderPath;
  renameFolder = renameConsoleFolder;
  deleteFolder = deleteConsoleFolder;
  moveFolder = moveConsoleFolder;

  /** The legacy `_isPrivate` argument was never read; `access` decides. */
  createFolder(
    folderName: string,
    workspaceId: string,
    userId: string,
    parentId?: string,
    _isPrivate: boolean = false,
    access?: Parameters<typeof createConsoleFolder>[4],
  ) {
    return createConsoleFolder(
      folderName,
      workspaceId,
      userId,
      parentId,
      access,
    );
  }
}
