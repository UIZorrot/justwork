# JustWork website

Standalone marketing, documentation, changelog, download, privacy, disclaimer, and web app deployment for `justwork.txzy.net`.

## Local development

```powershell
yarn dev:site
```

The standalone website runs through Vite. The production build also embeds the existing JustWork web app at `/app/`.

## Release asset

The checked-in ZIP under `website/public/downloads/` must match the root `package.json` version. To refresh it after changing the extension version:

```powershell
yarn package:chrome-store
Copy-Item "justwork-chrome-store-v$((Get-Content package.json -Raw | ConvertFrom-Json).version).zip" website/public/downloads/
```

The site build generates `downloads/latest.json` with the package size and SHA-256 checksum.

## Build and deploy

```powershell
yarn build:site
npx wrangler@4 pages deploy dist-site --project-name=justwork
```

In Cloudflare Pages, attach `justwork.txzy.net` under **Custom domains** after the first deployment. The `txzy.net` zone must be available in the same Cloudflare account.
