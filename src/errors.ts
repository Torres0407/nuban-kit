export type NubanKitErrorCode =
  | 'INVALID_ACCOUNT_NUMBER'
  | 'BANK_NOT_FOUND'
  | 'PROVIDER_ERROR'
  | 'RATE_LIMITED';

/**
 * Base class for every error nuban-kit throws on purpose. Switch on `code`
 * or use `instanceof` with the concrete classes.
 *
 * Error messages never contain account numbers or API keys.
 */
export abstract class NubanKitError extends Error {
  abstract readonly code: NubanKitErrorCode;
}

/** True if `error` is any nuban-kit error. */
export function isNubanKitError(error: unknown): error is NubanKitError {
  return error instanceof NubanKitError;
}

/**
 * - `format`: not exactly 10 digits.
 * - `check-digit`: failed the offline NUBAN check for the given bank.
 * - `not-found`: the provider could not resolve this account at this bank.
 */
export type InvalidAccountNumberReason = 'format' | 'check-digit' | 'not-found';

const INVALID_ACCOUNT_MESSAGES: Record<InvalidAccountNumberReason, string> = {
  format: 'Account number must be exactly 10 digits.',
  'check-digit': 'Account number failed NUBAN check-digit validation for this bank.',
  'not-found': 'Account could not be resolved at this bank.',
};

export class InvalidAccountNumberError extends NubanKitError {
  override readonly name = 'InvalidAccountNumberError';
  readonly code = 'INVALID_ACCOUNT_NUMBER' as const;
  readonly reason: InvalidAccountNumberReason;

  constructor(reason: InvalidAccountNumberReason, options?: ErrorOptions) {
    super(INVALID_ACCOUNT_MESSAGES[reason], options);
    this.reason = reason;
  }
}

export class BankNotFoundError extends NubanKitError {
  override readonly name = 'BankNotFoundError';
  readonly code = 'BANK_NOT_FOUND' as const;
  readonly bankCode: string;

  constructor(bankCode: string, options?: ErrorOptions) {
    super(`Bank code "${bankCode}" was not recognised.`, options);
    this.bankCode = bankCode;
  }
}

export interface ProviderErrorInit {
  provider: string;
  /** HTTP status, when the failure came from an HTTP response. */
  status?: number | undefined;
  /** The provider's own error message, when it sent one (truncated). */
  providerMessage?: string | undefined;
  /** Whether retrying the same request might succeed. Defaults to false. */
  retryable?: boolean | undefined;
  cause?: unknown;
}

/** The provider failed, or returned something unusable. */
export class ProviderError extends NubanKitError {
  override readonly name = 'ProviderError';
  readonly code = 'PROVIDER_ERROR' as const;
  readonly provider: string;
  readonly status: number | undefined;
  readonly providerMessage: string | undefined;
  readonly retryable: boolean;

  constructor(message: string, init: ProviderErrorInit) {
    super(message, 'cause' in init ? { cause: init.cause } : undefined);
    this.provider = init.provider;
    this.status = init.status;
    this.providerMessage = init.providerMessage;
    this.retryable = init.retryable ?? false;
  }
}

/** The provider rate-limited us (HTTP 429). Always safe to retry later. */
export class RateLimitedError extends NubanKitError {
  override readonly name = 'RateLimitedError';
  readonly code = 'RATE_LIMITED' as const;
  readonly provider: string;
  /** How long the provider asked us to wait, if it said. */
  readonly retryAfterMs: number | undefined;

  constructor(provider: string, retryAfterMs?: number) {
    super(
      retryAfterMs === undefined
        ? `${provider} rate limit reached.`
        : `${provider} rate limit reached; retry after ${retryAfterMs}ms.`,
    );
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}
