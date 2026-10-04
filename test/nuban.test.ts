import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BANKS,
  computeCheckDigit,
  getPossibleBanks,
  isValidAccountNumberFormat,
  validateNuban,
} from '../src/index.js';
import type { Bank } from '../src/index.js';

/*
 * Hand-computed vectors (weights 3,7,3,3,7,3,3,7,3,3,7,3):
 *
 * 044 + 000000001 -> digits 0 4 4 0 0 0 0 0 0 0 0 1
 *   0*3 + 4*7 + 4*3 + 1*3 = 28 + 12 + 3 = 43 -> 10 - 3 = 7  => 0000000017
 * 058 + 000000001 -> 0*3 + 5*7 + 8*3 + 1*3 = 35 + 24 + 3 = 62 -> 10 - 2 = 8 => 0000000018
 * 058 + 123456789 -> sum 254 -> 10 - 4 = 6                    => 1234567896
 * 044 + 000000000 -> sum 40 -> 10 - 0 = 10 -> wraps to 0      => 0000000000
 */

describe('isValidAccountNumberFormat', () => {
  it('accepts exactly 10 digits, including leading zeros', () => {
    expect(isValidAccountNumberFormat('0123456789')).toBe(true);
    expect(isValidAccountNumberFormat('0000000000')).toBe(true);
  });

  it.each(['', '123456789', '12345678901', '12345 6789', ' 123456789', '12345678a9', '１２３４５６７８９０'])(
    'rejects %j',
    (value) => {
      expect(isValidAccountNumberFormat(value)).toBe(false);
    },
  );

  it('rejects non-strings so leading zeros are never lost', () => {
    expect(isValidAccountNumberFormat(1234567890)).toBe(false);
    expect(isValidAccountNumberFormat(null)).toBe(false);
    expect(isValidAccountNumberFormat(undefined)).toBe(false);
  });
});

describe('computeCheckDigit', () => {
  it.each([
    ['044', '000000001', 7],
    ['058', '000000001', 8],
    ['058', '123456789', 6],
  ])('bank %s serial %s -> %i', (bank, serial, expected) => {
    expect(computeCheckDigit(bank, serial)).toBe(expected);
  });

  it('maps a computed value of 10 to 0', () => {
    expect(computeCheckDigit('044', '000000000')).toBe(0);
  });

  it.each([
    ['44', '000000001'],
    ['0444', '000000001'],
    ['04a', '000000001'],
    ['044', '00000001'],
    ['044', '0000000001'],
    ['044', '00000000x'],
    ['', ''],
  ])('returns null for malformed input (%j, %j)', (bank, serial) => {
    expect(computeCheckDigit(bank, serial)).toBeNull();
  });
});

describe('validateNuban', () => {
  it('accepts correct check digits', () => {
    expect(validateNuban('0000000017', '044')).toBe(true);
    expect(validateNuban('0000000018', '058')).toBe(true);
    expect(validateNuban('1234567896', '058')).toBe(true);
  });

  it('accepts the check-digit-wraps-to-zero case', () => {
    expect(validateNuban('0000000000', '044')).toBe(true);
  });

  it('rejects a valid account number against the wrong bank', () => {
    expect(validateNuban('0000000017', '058')).toBe(false);
    expect(validateNuban('0000000018', '044')).toBe(false);
  });

  it('rejects every wrong check digit', () => {
    for (let d = 0; d <= 9; d++) {
      if (d === 6) continue;
      expect(validateNuban(`123456789${d}`, '058')).toBe(false);
    }
  });

  it('detects any single-digit error in the serial number', () => {
    const valid = '1234567896';
    for (let pos = 0; pos < 9; pos++) {
      for (let digit = 0; digit <= 9; digit++) {
        if (String(digit) === valid[pos]) continue;
        const mutated = valid.slice(0, pos) + String(digit) + valid.slice(pos + 1);
        expect(validateNuban(mutated, '058')).toBe(false);
      }
    }
  });

  it('rejects malformed account numbers or bank codes without throwing', () => {
    expect(validateNuban('123456789', '058')).toBe(false);
    expect(validateNuban('12345678960', '058')).toBe(false);
    expect(validateNuban('1234567896', '58')).toBe(false);
    expect(validateNuban('1234567896', '')).toBe(false);
    expect(validateNuban('abcdefghij', '058')).toBe(false);
  });
});

describe('getPossibleBanks', () => {
  it('includes the bank the number was generated for', () => {
    const codes = getPossibleBanks('1234567896').map((b) => b.code);
    expect(codes).toContain('058');

    const accessCodes = getPossibleBanks('0000000017').map((b) => b.code);
    expect(accessCodes).toContain('044');
    expect(accessCodes).not.toContain('058');
  });

  it('only returns banks whose code actually validates', () => {
    const result = getPossibleBanks('1234567896');
    expect(result.length).toBeGreaterThan(0);
    for (const bank of result) {
      expect(validateNuban('1234567896', bank.code)).toBe(true);
    }
  });

  it('returns an empty array for invalid account number formats', () => {
    expect(getPossibleBanks('123')).toEqual([]);
    expect(getPossibleBanks('abcdefghij')).toEqual([]);
    expect(getPossibleBanks('')).toEqual([]);
  });

  it('uses a custom bank list and preserves its order', () => {
    const custom: Bank[] = [
      { code: '058', name: 'Test GT' },
      { code: '044', name: 'Test Access' },
    ];
    expect(getPossibleBanks('0000000018', custom)).toEqual([{ code: '058', name: 'Test GT' }]);
    expect(getPossibleBanks('0000000017', custom)).toEqual([{ code: '044', name: 'Test Access' }]);
  });

  it('skips banks whose code is not 3 digits', () => {
    const custom: Bank[] = [
      { code: '999992', name: 'Fintech' },
      { code: '50211', name: 'MFB' },
      { code: '044', name: 'Access' },
    ];
    expect(getPossibleBanks('0000000017', custom).map((b) => b.code)).toEqual(['044']);
  });
});

describe('DEFAULT_BANKS', () => {
  it('has unique 3-digit codes and non-empty names', () => {
    const codes = DEFAULT_BANKS.map((b) => b.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const bank of DEFAULT_BANKS) {
      expect(bank.code).toMatch(/^\d{3}$/);
      expect(bank.name.length).toBeGreaterThan(0);
    }
  });
});
