# Best Speed

Chrome extension (Manifest V3) that watches job search pages on **CrowdWorks**, **Lancers** and **Coconala**, and sends a template-based proposal when a new job appears. It uses the accounts already logged in to the browser.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → choose this folder.
3. Click the extension icon → **Settings**. Edit the template, price and filters for each site, then **Save**.
4. Click **Start**.

## How it works

- On Start, a separate Chrome window opens with one pinned tab per enabled site's search URL. These tabs reload every *N* seconds (minimum 30, which is the shortest interval `chrome.alarms` allows).
- The first scan of each site only records the jobs already listed. After that, each newly listed job is checked against the keyword filters and queued.
- Queued jobs are handled one at a time. For each one, the extension opens the job page, clicks the 応募する / 提案する button, fills the proposal form and then:
  - **Auto-submit OFF** (the default): the filled form is left open and a notification appears. Click it to review the form and send it yourself.
  - **Auto-submit ON**: it presses the final submit button (and the confirm button too, if the site shows a confirmation page).
- Before submitting, the extension fills the largest message textarea, the price field (when a price is set) and empty date fields (today + N days), and ticks agreement checkboxes. If any required field is still empty, it stops, leaves the tab open and notifies you.
- Rate limits (bids per hour and per day) apply. Tabs for failed bids stay open and log an error. Tabs for successful bids close on their own.

- **Bid on jobs already listed** (Settings): on Start, every job already on the search page is queued as well, and they are opened and bid on one by one.
- **Bid on this job** (popup): while viewing a job page or its proposal form, click this button to fill in that page's bid form (and submit it if auto-submit is on). It works even when watching is stopped, so it's a good way to check the form filling on each site.

Template placeholders: `{title}`, `{url}`, `{site}`, `{date}`.

## Files

| File | Purpose |
|---|---|
| `sites.js` | Per-site URLs, link patterns, button text and default settings |
| `background.js` | Scheduler, monitor tabs, seen-job tracking, bid queue, notifications |
| `content.js` | Reads job lists on search pages and fills/submits proposal forms |
| `options.*`, `popup.*`, `ui.*` | Settings page and toolbar popup |

## Notes

- The proposal forms are only visible when logged in, so form detection works by heuristics (field names and labels, button text). Run with auto-submit OFF first and check the result on each site. If a site's form isn't recognised, adjust `proposeButtonRe` in `sites.js`, or the regexes at the top of the bid section in `content.js`.
- Automated proposals may be against a platform's terms of service. Check each site's rules, because your account is the one at risk.
