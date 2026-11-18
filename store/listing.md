# Chrome Web Store listing: Tabmate

Upload: `dist/tabmate-webstore.zip` (manifest at the zip root). Build it with `npm run build`.

## Product details

**Name:** Tabmate

**Summary (max 132 characters):**
You work once. Tabmate does it forever. Learns the tasks you repeat in Chrome and does them for you.

**Category:** Productivity → Workflow & Planning

**Language:** English

**Description:**

You work once. Tabmate does it forever.

Tabmate watches how you work in your browser. When you do the same task twice, it learns it, even when the task jumps between tabs and sites (copy a row here, paste it there, click Add). The next time you start that task, Tabmate finishes it for you, row after row.

How it works
• Do a task, like exporting leads from your CRM.
• Do it again. A small pill at the bottom of the page says "Learned".
• Start it a third time. Tabmate takes over and does the rest, in every tab it needs. A lime cursor shows each click before it happens.
• Working down a list? Tabmate fills each new row with that row's data instead of repeating old values.

Works with Claude
• Every learned workflow can be a tool for Claude Desktop and Claude Code. One command in Terminal connects them. The link stays on your computer (127.0.0.1).

You stay in charge
• Press Esc, or click anywhere, and it stops right away.
• Turn any workflow on or off, run it, or delete it from the toolbar.
• See an activity log of everything Tabmate did.
• Pause it everywhere, or turn it off for one site.

Safe by design
• Never records passwords, card numbers, CVV or SSN fields.
• Never types into them. It stops and asks you to fill them.
• Never clicks pay, buy, purchase, delete or transfer buttons. It stops and lets you click.

Private
• Everything stays on your computer.
• No account, no server, no analytics. The only connection Tabmate can make is to Claude on your own computer, and only if you turn it on.

Try it in a minute with the built-in sandbox CRM. Tabmate is free and open source (MIT).

## Graphic assets

| Asset | File |
|---|---|
| Store icon 128×128 | `store/icon-128.png` |
| Screenshot 1 (1280×800) | `store/store-1-learns.png` |
| Screenshot 2 (1280×800) | `store/store-2-does-it.png` |
| Screenshot 3 (1280×800) | `store/store-3-safe.png` |
| Screenshot 4 (1280×800) | `store/store-4-popup.png` |
| Screenshot 5 (1280×800) | `store/store-5-start.png` |
| Large icon (for promo use) | `store/icon-512.png` |

Small promo tile (440×280) and marquee (1400×560): not made. They are optional.

## Privacy practices tab

**Single purpose:**
Tabmate learns the browser tasks a user repeats (on one site or across several tabs and sites) and does them for that user.

**Permission justifications:**

- `storage`: Saves learned workflows, settings and the activity log in the user's browser (chrome.storage.local). Nothing is sent anywhere.
- `tabs`: Finds and focuses the right tab for each step of a workflow (workflows can span tabs and sites), opens a page a workflow needs, and opens the welcome page on install.
- `alarms`: Every 30 seconds, while the user has turned on "Connect to Claude", looks for the local Claude link (tabmate-mcp) on 127.0.0.1. Off by default.
- `activeTab`: Shows the current site in the popup so the user can turn watching on or off for it.
- `scripting`: Starts Tabmate in a tab that was already open before install, when the user clicks Run in the popup.
- Host permission `<all_urls>`: Tabmate must run on the sites where the user works to learn and repeat their tasks. The user can block any site or pause Tabmate.

**Remote code:** No, I am not using remote code. All JavaScript is in the package.

**Network:** The extension sends nothing to any server. When the user turns on "Connect to Claude", it opens a WebSocket to 127.0.0.1 (the user's own computer) to talk to the open-source tabmate-mcp program, which the user installs. Both sides prove a shared random pairing token; the token itself is never sent.

**Data usage (what to tick):**

Tabmate handles some data only on the user's device. The Chrome Web Store asks what the extension "collects", meaning data sent off the device. Tabmate sends nothing, so the strict answer is none. To be clear with users, tick these and explain local-only use in the description and privacy policy:

- [x] Website content (field values the user typed, text the user copied, button text) – stored locally to replay workflows
- [x] User activity (clicks, form inputs, page navigation) – stored locally to detect repeated tasks
- [ ] Personally identifiable information – not collected
- [ ] Health information – not collected
- [ ] Financial and payment information – not collected (card fields are never recorded)
- [ ] Authentication information – not collected (password fields are never recorded)
- [ ] Personal communications – not collected
- [ ] Location – not collected
- [ ] Web history – not collected beyond page paths inside a learned workflow, stored locally

**Certifications (tick all three):**

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://trytabmate.com/privacy

Note: the current privacy policy on trytabmate.com describes a future cloud version (service providers, account data). The open-source extension stores everything locally. Update the policy to say this before submitting, or reviewers may flag the mismatch.

## Before you submit (not done yet)

- [ ] Developer account and one-time fee
- [ ] Update the privacy policy as noted above
- [ ] Upload `dist/tabmate-webstore.zip`, the icon and screenshots
- [ ] Paste the text above
