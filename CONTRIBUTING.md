# Contributing

## Local development

```bash
npm install
npm run lint
npm run build
```

Use `npm run dev` for the n8n node CLI dev mode.

## Releasing

This repository publishes to [npm](https://www.npmjs.com/package/n8n-nodes-slng)
automatically when changes land on `main`, via
[`.github/workflows/publish.yml`](.github/workflows/publish.yml).

The release workflow:

1. Installs dependencies with `npm ci`
2. Builds and lints the node package
3. Uses Conventional Commit messages to choose the next version
4. Updates `CHANGELOG.md`, `package.json`, and `package-lock.json`
5. Publishes the package to npmjs.com
6. Creates a GitHub Release with the generated `.tgz` tarball attached

Versioning is driven by Conventional Commits:

- `feat:` creates a minor release
- `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`, `ci:`, `test:`, `style:`, and `build:` create patch releases
- `BREAKING CHANGE:` in the commit body, or `!` in the commit header, creates a major release

Each squash-merged PR to `main` should use a Conventional Commit title, for
example `feat: add SLNG trigger options` or `fix: normalize trigger arguments`.

### npm authentication

Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
with GitHub Actions OIDC (`provenance: true`), configured for this repository
and `.github/workflows/publish.yml`. No `NPM_TOKEN` is required for normal
releases.

> **Note:** Trusted Publishing / OIDC cannot create a package that does not yet
> exist on npm. The first-ever publish of the package was done manually with
> `npm publish --access public --no-provenance`. This only matters if the
> package is ever unpublished and needs to be recreated.

## Installing from a tarball (internal testing)

For a quick local test without going through npm:

```bash
npm run build
npm pack   # produces n8n-nodes-slng-<version>.tgz

mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install /path/to/n8n-nodes-slng-<version>.tgz
```

Restart n8n after installing.

## Baking into an n8n Docker image

For production, prefer a custom n8n image with the package installed at build time:

```dockerfile
FROM n8nio/n8n:latest

USER root

RUN mkdir -p /home/node/.n8n/nodes \
	&& cd /home/node/.n8n/nodes \
	&& npm install n8n-nodes-slng

USER node
```

```bash
docker build -t slng/n8n:with-slng-nodes .
```

Existing workflows keep using the same node type names (`slng` and
`slngTrigger`), so updates are backward-compatible unless the node schema
changes.
