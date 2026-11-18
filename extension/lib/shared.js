/* Tabmate shared helpers. Loaded by the service worker (importScripts),
   the content script and the extension pages. Pure functions only. */
(function (root) {
  'use strict';

  const UPDATES_URL = 'https://trytabmate.com';
  const MIN_STEPS = 3;
  const MAX_STEPS = 25;
  const HISTORY_CAP = 80;
  const SESSION_GAP_MS = 20 * 60 * 1000; // a pause this long starts a new session
  // Local ports the Claude bridge (tabmate-mcp) may listen on. Only 127.0.0.1 is ever contacted.
  const BRIDGE_PORTS = [47821, 47822, 47823, 47824, 47825, 47826, 47827, 47828, 47829, 47830];

  // Buttons whose text matches this always wait for the person.
  const RISKY = /\b(pay|buy|purchase|delete|transfer|confirm payment)\b/i;

  // Fields Tabmate never records or types into.
  const SENSITIVE_WORDS = /pass(word|wd|code)?\b|pwd|card|cc-?(num|number|csc|exp)|cvv|cvc|csc|ssn|social.?security/i;

  // Path pattern: numeric or id-like segments become "*".
  function pathPattern(pathname) {
    return (pathname || '/')
      .split('/')
      .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) ? '*' : seg))
      .join('/');
  }

  function isRisky(text) {
    return RISKY.test(String(text || ''));
  }

  function formatSaved(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return '~' + s + ' sec';
    return '~' + Math.round(s / 60) + ' min';
  }

  // The one command that connects Claude. tabmate-mcp is installed straight from GitHub (it is not on npm).
  const MCP_PACKAGE = 'github:LuisSantiagoLopez/tabmate-mcp';
  function claudeCommand(token) {
    return 'npx -y ' + MCP_PACKAGE + ' install --token ' + (token || '');
  }

  function siteLabel(site) {
    if (!site) return '';
    if (/^[a-p]{32}$/.test(site)) return 'Tabmate sandbox';
    return site;
  }

  root.TabmateShared = {
    UPDATES_URL, MIN_STEPS, MAX_STEPS, HISTORY_CAP, SESSION_GAP_MS,
    RISKY, SENSITIVE_WORDS, pathPattern, isRisky, formatSaved, siteLabel, BRIDGE_PORTS, MCP_PACKAGE, claudeCommand,
  };
  if (typeof module === 'object' && module.exports) module.exports = root.TabmateShared;
})(typeof self !== 'undefined' ? self : globalThis);
