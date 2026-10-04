import { describe, expect, it } from 'vitest';
import {
  BankNotFoundError,
  InvalidAccountNumberError,
  NubanKitError,
  ProviderError,
  RateLimitedError,
  isNubanKitError,
} from '../src/index.js';

describe('typed errors', () => {
  it('InvalidAccountNumberError carries a reason and a safe message', () => {
    const e = new InvalidAccountNumberError('check-digit');
    expect(e).toBeInstanceOf(NubanKitError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('INVALID_ACCOUNT_NUMBER');
    expect(e.name).toBe('InvalidAccountNumberError');
    expect(e.reason).toBe('check-digit');
    expect(e.message).toMatch(/check-digit/);
  });

  it('BankNotFoundError exposes the bank code', () => {
    const e = new BankNotFoundError('999');
    expect(e.code).toBe('BANK_NOT_FOUND');
    expect(e.bankCode).toBe('999');
  });

  it('ProviderError defaults to non-retryable and keeps its cause', () => {
    const cause = new Error('boom');
    const e = new ProviderError('failed', { provider: 'paystack', status: 500, cause });
    expect(e.code).toBe('PROVIDER_ERROR');
    expect(e.provider).toBe('paystack');
    expect(e.status).toBe(500);
    expect(e.retryable).toBe(false);
    expect(e.cause).toBe(cause);
  });

  it('ProviderError without a cause has no cause', () => {
    const e = new ProviderError('failed', { provider: 'paystack' });
    expect(e.cause).toBeUndefined();
    expect('cause' in e).toBe(false);
  });

  it('RateLimitedError exposes retryAfterMs when known', () => {
    expect(new RateLimitedError('paystack', 1500).retryAfterMs).toBe(1500);
    expect(new RateLimitedError('paystack').retryAfterMs).toBeUndefined();
    expect(new RateLimitedError('paystack').code).toBe('RATE_LIMITED');
  });

  it('isNubanKitError narrows only our errors', () => {
    expect(isNubanKitError(new RateLimitedError('paystack'))).toBe(true);
    expect(isNubanKitError(new Error('x'))).toBe(false);
    expect(isNubanKitError('x')).toBe(false);
  });
});
