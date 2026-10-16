# Take Radar

Highlights names from your lists on every page you visit. Each list gets its
own highlight style: a fill, an optional border, and opacity for both, so a
list can be a solid marker, a light tint, or just a box around the name.
Hovering a highlight shows a card with every list the person is on and any
notes.

- **Names on several lists** are hatched with each list's fill, with one
  border ring per list that has a border.
- **Later mentions by last name** ("Ms. Lake said") are highlighted once the
  full name has appeared on the page. Surnames that also belong to another
  person found on the page are skipped, as are look-alikes such as
  "Lake Tahoe". Surnames that are everyday words ("Short", "Law") need an
  honorific at the start of a sentence. Can be turned off per list.
- **On this page**: the popup lists who was found on the current tab; click
  a name to scroll to each mention in turn.
- **Hide a list** without deleting it.

- **Starter lists**, all opt-in: Republican operatives, Democratic
  operatives, and the Harper's Letter signatories (see `lists/`).
- **Lists from a URL**: point at a `.txt` or `.csv` file and it's re-checked
  twice a day. The starter lists sync this way from this repo, so fixes to
  them reach users without a new release.
- **Toolbar badge** with the number of names on the current page.
- **Pause** everywhere (switch in the panel, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>),
  or turn it off for a single site.
- Works inside **Shadow DOM** (web components, e.g. new Reddit), including
  closed shadow roots in Chrome and Firefox.

## Files

| File | What it does |
| --- | --- |
| `manifest.json` | MV3 manifest that works in Chrome, Safari and Firefox |
| `shared.js` | List and settings shapes, list-file parsing, colors and the highlight style; shared by every context |
| `matcher.js` | Finds names in text (accents, initials, middle initials); no DOM, so it's unit-tested |
| `content.js` | Walks the page and its shadow roots, wraps matches in highlights, reports the count |
| `background.js` | Install/upgrade, the toolbar badge, scheduled list refreshes, the pause shortcut |
| `options.html/.css/.js` | The settings panel, used both as the toolbar popup and as a full-page options tab |
| `color-picker.js` | The in-panel color picker (see below) |
| `lists/` | The starter lists, bundled and synced from GitHub |
| `tests/` | Unit tests (`npm test`) and end-to-end tests in Chromium (`npm run test:e2e`) |

## List format

One name per line. Anything after a `|` is a note shown in the tooltip, and
lines starting with `#` are comments:

```
# My list
Jane Doe | former campaign spokeswoman
John Roe
```

A `.csv` with a header row uses the `name` column, plus a `note`, `notes`,
`description` or `role` column if there is one. A CSV without a `name`
header treats every cell as a name.

To fix or add someone on a starter list, edit the file in `lists/` and
merge to `main`; installed copies pick it up within 12 hours.

## Why a custom color picker

In Chrome, `<input type="color">` opens the OS color panel as a separate
window. On macOS that takes focus away from the extension popup, and Chrome
closes the popup when it loses focus. The native input also can't do
transparency. `color-picker.js` draws the picker inside the panel instead.

## Chrome / Edge / Brave

`chrome://extensions` → Developer mode → **Load unpacked** → pick this folder
(or unzip the output of `npm run package` and load that).

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

Requires Safari 16.4 or later. Closed shadow roots can't be read in Safari,
so text inside them isn't highlighted there.

## Firefox

`about:debugging` → This Firefox → **Load Temporary Add-on** → pick
`manifest.json`. Firefox 121+ reads `background.scripts` and ignores
`service_worker`. Chrome does the reverse.

## Publishing to the Chrome Web Store

`.github/workflows/publish-chrome.yml` runs on every push to `main`. It
runs the tests (`.github/workflows/test.yml`, which also runs on pull
requests) and builds the zip (`scripts/package.sh`, also saved as a
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

Before uploading, the publish script asks the store what it has. A version
that's already published or submitted (for example, one you submitted by
hand in the dashboard) isn't uploaded again; the workflow just tags it. If
a different version is still in review, the run stops and says so; wait
for the review, or cancel it in the dashboard, then re-run the workflow.

If the upload works but submitting fails, the version is left as a draft
in the dashboard. That usually means the dashboard needs something first,
such as justifications for new permissions. Fix that and submit the draft
there; the next run sees it and tags the release.

## Development

```sh
npm install
npm test            # unit tests
npm run test:e2e    # loads the packaged extension in Chromium
```

## Storage format

`storage.local`:

- `lists: [{ id, name, fill, border, borderWidth, names, enabled?, followups?, starterId?, source? }]`.
  `fill` and `border` are `#rrggbbaa`; `names` are lines in the list format
  above; `source: { url, updatedAt, error }` marks a list synced from a URL.
  `enabled` and `followups` are only stored as `false` (hidden list; no
  last-name matches).
- `settings: { paused, disabledHosts }`.

Lists saved by 0.3 had only a `color` field. They still load, and they're
upgraded on the next install or update. Installs from before 0.5 keep their
Harper's Letter list; new installs start with no lists.
