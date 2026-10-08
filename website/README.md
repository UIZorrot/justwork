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

## Chrome Web Store privacy policy

The current store draft uses `https://www.tianxiazhengyi.net/justwork/privacy.html`. That URL is maintained in the separate `D:/txzy_website` repository. It must return the JustWork privacy policy directly, including its product name and extension ID, with publicly readable HTML and no login requirement. Preserve it when changing the legacy site's routes.

The policy sources in this repository are `website/privacy/index.html` and `website/en/privacy/index.html`, deployed at `https://justwork.txzy.net/privacy/` and `https://justwork.txzy.net/en/privacy/`. Keep the legacy site's copy consistent with these sources when changing data processing disclosures.

The remote backend receives passwords over HTTPS for authorized operations and can decrypt workspace data and process collaboration updates. Encrypted storage does not make the service end-to-end encrypted against the backend. Store descriptions and privacy disclosures must reflect this behavior, including local identity, workspace content, and collaboration data.

For a rejection limited to the privacy-policy URL, verify the exact URL in the dashboard's designated Privacy Policy field and resubmit the existing draft after the page is published. A website-only policy correction does not require rebuilding the extension ZIP. The existing published listing may have a different URL; check the draft itself rather than copying that listing's old metadata.
