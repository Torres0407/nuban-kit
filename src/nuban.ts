import { DEFAULT_BANKS } from './banks.js';
import type { Bank } from './banks.js';

/** Length of a NUBAN account number (9 serial digits + 1 check digit). */
export const NUBAN_LENGTH = 10;

/** Length of the CBN bank code used by the NUBAN algorithm. */
export const BANK_CODE_LENGTH = 3;

/** Weights applied to the 12 digits of `bankCode + serialNumber`. */
const WEIGHTS = [3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3] as const;

const ACCOUNT_NUMBER_RE = /^\d{10}$/;
const BANK_CODE_RE = /^\d{3}$/;
const SERIAL_RE = /^\d{9}$/;

/**
 * True if `value` is a string of exactly 10 digits.
 *
 * Input must be a string: account numbers can start with 0, so numbers are
 * rejected rather than silently losing leading zeros. Whitespace is not trimmed.
 */
export function isValidAccountNumberFormat(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_NUMBER_RE.test(value);
}

/**
 * Compute the NUBAN check digit for a 3-digit bank code and 9-digit serial number.
 *
 * Algorithm: multiply each of the 12 digits of `bankCode + serialNumber` by the
 * weights 3,7,3,3,7,3,3,7,3,3,7,3 and sum them. The check digit is
 * `10 - (sum mod 10)`, with a result of 10 becoming 0.
 *
 * @returns the check digit (0-9), or `null` if either input is malformed.
 */
export function computeCheckDigit(bankCode: string, serialNumber: string): number | null {
  if (!BANK_CODE_RE.test(bankCode) || !SERIAL_RE.test(serialNumber)) {
    return null;
  }
  const digits = bankCode + serialNumber;
  const sum = WEIGHTS.reduce((acc, weight, i) => acc + weight * (digits.charCodeAt(i) - 48), 0);
  return (10 - (sum % 10)) % 10;
}

/**
 * Check whether a 10-digit account number passes the NUBAN check-digit test
 * for the given 3-digit bank code.
 *
 * A pass means the number is *consistent* with that bank, not that the account
 * exists. Use the provider client to confirm an account is real.
 */
export function validateNuban(accountNumber: string, bankCode: string): boolean {
  if (!isValidAccountNumberFormat(accountNumber)) return false;
  const expected = computeCheckDigit(bankCode, accountNumber.slice(0, 9));
  return expected !== null && expected === accountNumber.charCodeAt(9) - 48;
}

/**
 * Return the banks an account number could plausibly belong to, i.e. those
 * whose 3-digit code makes the check digit valid.
 *
 * The check digit is a single decimal digit, so roughly 1 in 10 banks will
 * match by chance: expect several candidates, not a unique answer. Use this to
 * narrow a bank dropdown or catch typos, not to identify a bank with certainty.
 *
 * @param accountNumber 10-digit account number as a string.
 * @param banks candidate banks; defaults to the bundled seed list. Entries
 *   whose code is not exactly 3 digits are skipped, since the algorithm
 *   does not apply to them.
 * @returns matching banks in input order, or `[]` if the format is invalid.
 */
export function getPossibleBanks(
  accountNumber: string,
  banks: readonly Bank[] = DEFAULT_BANKS,
): Bank[] {
  if (!isValidAccountNumberFormat(accountNumber)) return [];
  return banks.filter((bank) => validateNuban(accountNumber, bank.code));
}
