export class UserFacingError extends Error {
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;
  readonly followUpQuestion?: string;

  constructor(
    message: string,
    options?: {
      statusCode?: number;
      details?: Record<string, unknown>;
      followUpQuestion?: string;
    }
  ) {
    super(message);
    this.name = "UserFacingError";
    this.statusCode = options?.statusCode ?? 400;
    this.details = options?.details;
    this.followUpQuestion = options?.followUpQuestion;
  }
}

export function isUserFacingError(error: unknown): error is UserFacingError {
  return error instanceof UserFacingError;
}
