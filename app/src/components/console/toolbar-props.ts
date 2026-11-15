import type { TreeNode } from "../../store/schemaStore";

/** State + actions shared by the desktop and mobile console toolbars. */
export interface ConsoleToolbarProps {
  connectionId?: string;
  databaseId?: string;
  isClusterMode: boolean;
  /** Sub-databases of a cluster-mode connection. */
  clusterDatabases: TreeNode[];
  isLoadingDatabases: boolean;
  onConnectionChange: (connectionId: string) => void;
  onDatabaseSelect: (databaseId: string | undefined) => void;

  isReadOnly: boolean;
  isSaved: boolean;
  hasSchedule: boolean;
  hasUnsavedChanges: boolean;
  hasFilePath: boolean;
  isSaving?: boolean;
  isExecuting: boolean;
  isCancelling?: boolean;
  isDiffMode: boolean;
  canUndo: boolean;
  canRedo: boolean;
  enableVersionControl: boolean;
  historyAvailable: boolean;
  shareAvailable: boolean;

  onExecute: () => void;
  onCancel?: () => void;
  /** Present when the surface supports saving. */
  onSave?: () => void;
  canSaveAsCopy: boolean;
  onSaveAsCopy: () => void;
  canRenameMove: boolean;
  onRenameMove: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onHistoryClick?: (anchor: HTMLElement) => void;
  onShareClick?: () => void;
  /** Present when the surface supports scheduling. */
  onSchedule?: () => void;
  onInfo: () => void;
  headerExtras?: React.ReactNode;
}
