# Releasing

Releases are published to npm by GitHub Actions when a version tag is pushed.

## One-time setup

1. Create the package scope/name on npm and enable two-factor authentication on your account.
2. Create an npm **automation** access token limited to this package.
3. Add it to the GitHub repository as the secret `NPM_TOKEN` (Settings > Secrets and variables > Actions).
4. Fill in `repository`, `bugs` and `homepage` in `package.json` with your real repository URL, and check the copyright line in `LICENSE`.
5. Run `npm install` once and commit the generated `package-lock.json` (CI uses `npm ci`, which requires it).

npm's "trusted publishing" (OIDC) can replace the long-lived token; if you switch to it, remove `NPM_TOKEN` and follow npm's current documentation for configuring it.

## Cutting a release

1. Make sure `main` is green.
2. Update `CHANGELOG.md`: move items from "Unreleased" under a new version heading with today's date.
3. Bump the version without tagging yet: `npm version <patch|minor|major> --no-git-tag-version`.
4. Commit: `git commit -am "release: vX.Y.Z"` and push to `main`.
5. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The release workflow then checks the tag matches `package.json`, runs typecheck, lint, tests, build and the package check, and publishes with provenance.

## Before the very first publish

Preview exactly what will ship:

```sh
npm run build
npm pack --dry-run
```

You should see only `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md` and `package.json`. Test the tarball in a scratch project (`npm pack`, then `npm install ../nuban-kit-0.1.0.tgz`) with both `import` and `require`.
