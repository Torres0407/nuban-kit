/**
 * Run from the repo root:
 *   PAYSTACK_SECRET_KEY=sk_test_xxx npx tsx examples/resolve-account.ts <accountNumber> <bankCode>
 *
 * Only resolve accounts you own or have permission to check: account holder
 * names are personal data.
 */
import {
  BankNotFoundError,
  InvalidAccountNumberError,
  NubanClient,
  PaystackProvider,
  ProviderError,
  RateLimitedError,
  getPossibleBanks,
} from 'nuban-kit';

const secretKey = process.env['PAYSTACK_SECRET_KEY'];
if (!secretKey) {
  console.error('Set PAYSTACK_SECRET_KEY first (never hardcode it).');
  process.exit(1);
}

const [accountNumber, bankCode] = process.argv.slice(2);
if (!accountNumber || !bankCode) {
  console.error('Usage: npx tsx examples/resolve-account.ts <accountNumber> <bankCode>');
  process.exit(1);
}

const client = new NubanClient({
  provider: new PaystackProvider({ secretKey }),
  // Interactive-friendly limits: fail faster than the defaults.
  timeoutMs: 5000,
  retry: { retries: 1, onRetry: ({ attempt, delayMs }) => console.warn(`retry after attempt ${attempt} in ${delayMs}ms`) },
});

// 1. Offline: which banks could this number belong to? (no network, no key needed)
console.log(
  'Possible banks (offline):',
  getPossibleBanks(accountNumber).map((b) => b.name),
);

// 2. Online: resolve the account holder's name.
try {
  const account = await client.resolveAccount({ accountNumber, bankCode });
  console.log(`Resolved: ${account.accountName}`);

  // Served from cache this time: no second HTTP request.
  await client.resolveAccount({ accountNumber, bankCode });
} catch (error) {
  if (error instanceof InvalidAccountNumberError) {
    console.error(`Invalid account (${error.reason}).`);
  } else if (error instanceof BankNotFoundError) {
    console.error(`Unknown bank code: ${error.bankCode}`);
  } else if (error instanceof RateLimitedError) {
    console.error(`Rate limited; retry in ${error.retryAfterMs ?? 'a few'}ms.`);
  } else if (error instanceof ProviderError) {
    console.error(
      `Provider problem (HTTP ${error.status ?? 'n/a'}, retryable: ${error.retryable}): ${error.providerMessage ?? '(no message)'}`,
    );
  } else {
    throw error;
  }
  process.exitCode = 1;
}