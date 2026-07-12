export class AppV2ValidationError extends Error {}

export class AppV2ConflictError extends Error {}

export class AppV2MergeConflictError extends AppV2ConflictError {
  constructor(
    message: string,
    readonly branch: string,
    readonly defaultBranch: string,
  ) {
    super(message);
  }
}

export class AppV2RecoveryConflictError extends AppV2ConflictError {
  constructor(
    message: string,
    readonly recoveryRef: string,
  ) {
    super(message);
  }
}

export class AppV2OperationConflictError extends AppV2ConflictError {
  readonly retryable = true;
}

export class AppV2NotFoundError extends Error {}

export class AppV2LimitError extends Error {}

export class AppV2ProviderUnavailableError extends Error {}
