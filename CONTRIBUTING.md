# Contributing to Tabmate

Thanks for helping. This is an early test, so the most useful thing is telling us where it breaks.

## Report a bug

Open an issue with:

- The site (or a page like it, if it's private)
- The steps you did, in order
- What Tabmate did, and what you expected
- A screenshot of the pill or popup if you can

Please don't paste anything private. Tabmate's data lives only in your browser, so we never see it unless you share it.

## Make a change

1. Fork and clone the repo.
2. `npm install`
3. Load `extension/` in `chrome://extensions` (Developer mode, Load unpacked).
4. Make your change. After editing, click the reload icon on the Tabmate card.
5. Run `npm test`. All checks must pass.
6. Open a pull request that says what changed and why.

## Rules we keep

- **No network calls.** No analytics, no remote code, no CDNs. The tests fail if the extension makes a request. The one exception is the opt-in Claude link, and it only ever talks to 127.0.0.1.
- **Never record or type secrets.** Password, card, CVV and SSN fields stay "you fill this". If you touch the recorder or runner, keep those tests passing.
- **Stop means stop.** Esc and any real click end a run at once.
- **Small permissions.** Don't add a permission without saying why in the PR and the README.
- Plain JavaScript, no build step for the extension itself.
- Text in the UI: short, plain words, sentence case.

## License

By contributing, you agree your work is released under the [MIT License](LICENSE).
