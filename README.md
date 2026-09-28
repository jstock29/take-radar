# Take Radar

A simple tool to highlight and manage multiple lists of names (or any other text) to highlight in any color across the internet. Built to be lightweight and dead simple.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Click the toolbar icon to edit lists. Changes save automatically and apply to open tabs right away.

## Matching

Matching is forgiving so you don't have to list every spelling:

- Case, accents and punctuation are ignored: `Chloe Valdary` matches `Chloé Valdary`, `J.K. Rowling` matches `J. K. Rowling` and `JK Rowling`, curly and straight apostrophes are the same, and so are hyphens and dashes.
- A middle initial is optional: `David Blight` matches `David W. Blight` and vice versa.
- Only whole words match, so `Mia Bay` won't light up `Miami Bay`.

## Releasing

1. Bump `version` in `manifest.json`.
2. Run `./scripts/package.sh`. It writes `dist/take-radar-<version>.zip` with only the files the extension needs.
3. Upload the zip in the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole).

## Privacy

Take Radar collects nothing and makes no network requests. Your lists are stored locally in your browser (`chrome.storage.local`). It reads page text only to find matches, on the device.

Built with AI. 
