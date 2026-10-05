# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project follows [Semantic Versioning](https://semver.org/). Until 1.0.0, minor
versions may contain breaking changes.

## [0.1.0] - 2026-10-05

### Added
- Offline NUBAN validation: `validateNuban`, `computeCheckDigit`, `isValidAccountNumberFormat`.
- `getPossibleBanks` to find banks an account number could belong to.
- `AccountProvider` interface and a `PaystackProvider` (account resolution and bank list with cursor pagination).
- `NubanClient` with offline pre-validation, bank list helpers (`listBanks`, `getBank`, `getPossibleBanks`).
- Caching with a pluggable `CacheStore` and a bundled `MemoryCacheStore` (TTL + LRU).
- Per-attempt timeouts, retries with exponential backoff and jitter, `Retry-After` handling.
- Single-flight de-duplication of concurrent identical requests, with reference-counted cancellation.
- Typed errors: `InvalidAccountNumberError`, `BankNotFoundError`, `ProviderError`, `RateLimitedError`.
- ESM and CommonJS builds with type declarations.
