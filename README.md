# Take Radar

Highlights names from your lists on every page you visit. Each list gets its
own highlight style: a fill, an optional border, and opacity for both, so a
list can be a solid marker, a light tint, or just a box around the name.

## Files

| File | What it does |
| --- | --- |
| `manifest.json` | MV3 manifest that works in Chrome, Safari and Firefox |
| `shared.js` | Color math, list normalization and the highlight style, shared by every context |
| `content.js` | Finds names on the page and wraps them in highlight spans |
| `background.js` | Seeds the default list on install and upgrades older saved lists |
| `names.js` | The default (Harper's Letter) list |
| `options.html/.css/.js` | The settings panel, used both as the toolbar popup and as a full-page options tab |
| `color-picker.js` | The in-panel color picker (see below) |

## Why a custom color picker

In Chrome, `<input type="color">` opens the OS color panel as a separate
window. On macOS that takes focus away from the extension popup, and Chrome
closes the popup when it loses focus. The native input also can't do
transparency. `color-picker.js` draws the picker inside the panel instead.

## Chrome / Edge / Brave

`chrome://extensions` → Developer mode → **Load unpacked** → pick this folder.

## Safari (macOS / iOS)

Safari needs the extension wrapped in an app, which Xcode generates:

```sh
xcrun safari-web-extension-converter /path/to/this/folder \
  --app-name "Take Radar" --bundle-identifier com.example.takeradar
```

Build and run the generated project in Xcode. In Safari, open
**Settings → Advanced** and turn on **Show features for web developers**.
Then go to **Settings → Developer** and turn on **Allow unsigned
extensions**. Enable Take Radar under **Settings → Extensions** and grant
it access to all websites.

Requires Safari 16.4 or later, because name matching uses regex lookbehind.

## Firefox

`about:debugging` → This Firefox → **Load Temporary Add-on** → pick
`manifest.json`. Firefox 121+ reads `background.scripts` and ignores
`service_worker`. Chrome does the reverse.

## Publishing to the Chrome Web Store

`.github/workflows/publish-chrome.yml` runs on every push to `main`. It
checks syntax and builds the zip (`scripts/package.sh`, also saved as a
workflow artifact). If `manifest.json`'s `version` has no `v<version>` tag
yet, the workflow uploads that zip, submits it for review
(`scripts/cws-publish.sh`) and then pushes the tag. **To release, bump
`version` and push.**

The API only handles the package. Listing text, screenshots and promo tiles
live in `store-assets/`; when those files change, the workflow posts a
reminder to update them in the dashboard by hand.

One-time setup:

1. In [Google Cloud Console](https://console.cloud.google.com), pick or
   create a project and enable the **Chrome Web Store API**.
2. Create a service account (it needs no roles), then create a JSON key for
   it.
3. In the [Developer Dashboard](https://chrome.google.com/webstore/devconsole),
   open **Account** and add the service account's email.
4. In GitHub → Settings → Secrets and variables → Actions:
   - secret `CWS_SERVICE_ACCOUNT_KEY`: the JSON key's contents
   - variable `CWS_PUBLISHER_ID`: from the dashboard's **Publisher → Settings**

An upload fails while another version is still in review. Wait for that
review to finish, or cancel it in the dashboard, then re-run the workflow.

## Storage format

`storage.local` → `lists: [{ id, name, fill, border, borderWidth, names }]`,
where `fill` and `border` are `#rrggbbaa`. Lists saved by 0.3 had only a
`color` field. They still load, and they're upgraded on the next install or
update.
