import type { Bank } from './banks.js';

export interface ProviderRequestOptions {
  /** Abort the in-flight request. */
  signal?: AbortSignal | undefined;
}

export interface ResolveAccountParams extends ProviderRequestOptions {
  /** 10-digit account number. */
  accountNumber: string;
  /** The provider's code for the bank. */
  bankCode: string;
}

export interface ResolvedAccount {
  accountNumber: string;
  bankCode: string;
  /** Account holder name exactly as the bank returns it (trimmed). */
  accountName: string;
}

/**
 * Contract every account-verification provider (Paystack, Flutterwave, ...)
 * implements.
 *
 * Implementations must throw nuban-kit's typed errors, never raw HTTP errors:
 * - `InvalidAccountNumberError('not-found')` when the account does not exist at that bank
 * - `BankNotFoundError` when the bank code is unknown
 * - `RateLimitedError` on rate limiting
 * - `ProviderError` for everything else (set `retryable` honestly)
 *
 * Caller cancellation (`AbortError`) is allowed to propagate unchanged.
 */
export interface AccountProvider {
  /** Short stable identifier, e.g. `"paystack"`. Used in errors and cache keys. */
  readonly name: string;
  resolveAccount(params: ResolveAccountParams): Promise<ResolvedAccount>;
  /** All banks the provider supports, with every page fetched. */
  listBanks(options?: ProviderRequestOptions): Promise<Bank[]>;
}
