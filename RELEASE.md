# npm Trusted Publishing for @otomasi/remote

This PRIVATE repository is the isolated publishing source for the public npm package.
Canonical local source: `/media/sirobo/HDD/mcp/remote-pc-mcp/agent`.

## One-time owner setup on npmjs.com

Open **https://www.npmjs.com/package/@otomasi/remote/access** (or package Settings → Trusted publishing), sign in as npm user `otomasi`, and add a **GitHub Actions** Trusted Publisher with:

- GitHub organization/user: `rofiqcp`
- GitHub repository: `otomasi-remote-agent`
- Workflow filename: `publish.yml`
- Allowed action: **Allow npm publish**
- No GitHub environment (leave blank)

Use the package's official Settings page if the access URL redirects.
A manual approval / passkey may be required once during setup.
Do not disable 2FA or save an OTP, password, or npm automation token in a repository.

## Release

Use the allowlisted local sync script `scripts/release-npm-oidc.sh` from the canonical
project to copy the agent source into this repository, run tests, commit and push.
Push a release tag `vX.Y.Z` matching the package version to start publication.
The GitHub-hosted workflow obtains a short-lived OIDC identity on each run.

The workflow can also be started manually from GitHub Actions → Publish Otomasi Remote to npm → Run workflow after checking the version. Never trigger this before the Trusted Publisher is configured.

## Security notes

Only agent package source, package-lock.json and a small test suite are synced.
Hub databases, `.env`, device secrets and logs are never included.
The release workflow requires `id-token: write` and does not accept `NPM_TOKEN`.
You must continue to use two-factor authentication for the npm account itself.
