# Chrome Web Store listing: Take Radar

## Store listing tab

**Summary** (taken from the manifest `description`, 132 characters max)
> Highlights the people you're keeping an eye on, on every website you visit.

**Description**

Take Radar highlights the people you're keeping an eye on, on every website you visit.

Make a list of names, for example columnists whose takes you'd rather skip, writers you always want to read, or anyone else. Each time one of those names appears on a page, it's highlighted in that list's style. Hover over a highlight to see which list it came from, plus any note you've added about that person.

Optional starter lists help you spot partisan sources that news stories don't always identify:
• Republican operatives and Democratic operatives: strategists, pollsters, and campaign and party staff, including ones who now work in media. Each entry notes who the person is, so a quoted "strategist" or "pollster" comes with context.
• Signers of the 2020 Harper's Letter.
Starter lists are kept up to date automatically. Add any of them, or none, and make as many lists of your own as you like.

FEATURES
• Unlimited lists, each with its own highlight style
• Fill and border colors with adjustable opacity: a solid marker, a light tint, a box around the name, or a mix
• One-click presets, plus a full color picker
• Small spelling differences still match: accents (Tomas / Tomás), middle initials (Ruth A. Okafor), and initials written different ways (J.K. / JK / J. K.)
• Highlights content that loads after the page opens, such as infinite feeds and comment threads
• Leaves text boxes, editors and code alone
• Import names from a .txt or .csv file, or subscribe to a list at a web address that's re-checked twice a day
• Toolbar badge with the number of names on the current page
• Pause everywhere with one click or a keyboard shortcut, or turn it off for a single site
• Works inside web components (Shadow DOM)

PRIVACY
Your lists and settings are stored only in your browser. Page text is checked locally and never leaves your browser. The extension doesn't collect, send or sell any data. Its only network requests download the lists you've chosen: the starter lists from GitHub, and any list you add by web address.

**Category:** Tools (or Social & Communication)
**Language:** English

## Privacy practices tab

**Single purpose**
> Highlights names from the user's own lists wherever they appear on web pages.

**Permission justifications**

- `storage`: Saves the user's name lists, highlight styles and on/off settings locally in the browser.
- `alarms`: Re-checks lists the user subscribed to by web address twice a day.
- `activeTab`: Reads the current tab's address when the user opens the popup, to offer "Turn off for this site".
- Host permission (`<all_urls>`, via content script): The extension's only function is to find and highlight names on any page the user reads. It has to read page text on every site to do that. The text is processed locally and never leaves the browser.
- Optional host permissions (`https://*/*`, `http://*/*`): Requested only for the one site, and only if the user adds a list from a web address that doesn't allow cross-origin reads. Used solely to download that list.
- Remote code: **No.** All code is included in the package. Downloaded lists are plain text (names and notes) and are never executed.

**Data usage:** Check none of the data-type boxes. The extension does not collect or transmit user data. Then confirm all three certifications: data isn't sold to third parties, isn't used for purposes unrelated to the single purpose, and isn't used for creditworthiness or lending.

## Graphic assets

| Slot | File |
| --- | --- |
| Store icon (128×128) | `icons/icon-128.png` |
| Screenshots (1280×800) | `screenshot-1-highlights.png` … `screenshot-5-lists.png` (upload in that order) |
| Small promo tile (440×280) | `small-promo-tile-440x280.png` |
| Marquee promo tile (1400×560) | `marquee-promo-tile-1400x560.png` |

All images are 24-bit PNGs with no alpha channel. The names, publications and URLs in them are made up.
