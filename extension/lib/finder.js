/* Tabmate element finder. Describes an element so it can be found again later,
   and finds it again on a page that may have re-rendered, changed its ids, or moved things.
   Looks through open shadow roots and same-origin iframes. Content script only. */
(function (root) {
  'use strict';
  const S = root.TabmateShared;

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const cssEsc = (s) => (root.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

  // Ids that change on every render (React useId, hashes, counters) are not used as keys.
  function looksGenerated(id) {
    if (!id) return true;
    if (/\d{3,}|^[0-9a-f-]{8,}$|^(ember|react|radix|mui|headlessui)|^:r|[:]/i.test(id)) return true;
    return id.split(/[-_.]/).some((seg) => seg.length >= 5 && /\d/.test(seg) && /[a-z]/i.test(seg));
  }

  const FIELD = /^(INPUT|SELECT|TEXTAREA)$/;
  const isButtonInput = (el) => el.tagName === 'INPUT' && /^(submit|button|reset)$/.test(el.type);

  function roleOf(el) {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || isButtonInput(el)) return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'input' && /^(checkbox|radio)$/.test(el.type)) return el.type;
    if (t === 'textarea' || t === 'input' || el.isContentEditable) return 'textbox';
    return t;
  }

  function textOf(el) {
    if (isButtonInput(el)) return norm(el.value);
    return norm(el.innerText || el.textContent).slice(0, 60);
  }

  function rootOf(el) {
    const r = el.getRootNode();
    return r && r.querySelectorAll ? r : el.ownerDocument;
  }

  function labelText(el) {
    let t = '';
    if (el.labels && el.labels.length) t = norm(el.labels[0].innerText);
    const by = el.getAttribute('aria-labelledby');
    if (!t && by) {
      const r = rootOf(el);
      const l = r.getElementById ? r.getElementById(by.split(/\s+/)[0]) : null;
      if (l) t = norm(l.innerText);
    }
    return t.slice(0, 60);
  }

  // Short text just before the element: a label column, a legend, a heading.
  function nearText(el) {
    let cur = el;
    for (let depth = 0; cur && depth < 4; depth++) {
      let sib = cur.previousElementSibling;
      for (let hops = 0; sib && hops < 3; hops++, sib = sib.previousElementSibling) {
        const t = norm(sib.innerText || sib.textContent);
        if (t && t.length <= 40 && !FIELD.test(sib.tagName)) return t;
      }
      cur = cur.parentElement;
    }
    return '';
  }

  function friendlyLabel(el) {
    return (norm(el.getAttribute('aria-label')) || labelText(el) || norm(el.getAttribute('placeholder')) ||
      (FIELD.test(el.tagName) || el.isContentEditable ? nearText(el) : textOf(el)) || norm(el.getAttribute('name')) ||
      norm(el.getAttribute('title')) || el.tagName.toLowerCase()).slice(0, 60);
  }

  function nthPath(el, stopAt) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== stopAt && cur !== cur.ownerDocument.documentElement && parts.length < 7) {
      if (!stopAt && cur.id && !looksGenerated(cur.id)) { parts.unshift('#' + cssEsc(cur.id)); break; }
      const tag = cur.tagName.toLowerCase();
      let idx = 1, sib = cur;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === cur.tagName) idx++;
      parts.unshift(tag + ':nth-of-type(' + idx + ')');
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // Chain of shadow hosts (outermost first) and of iframes, so we can look in the right place.
  function hostChain(el) {
    const chain = [];
    let r = el.getRootNode();
    while (r && r.host) { chain.unshift(nthPath(r.host)); r = r.host.getRootNode(); }
    return chain;
  }
  function frameChain(el) {
    const chain = [];
    let w = el.ownerDocument.defaultView;
    try {
      while (w && w !== w.top && w.frameElement) { chain.unshift(nthPath(w.frameElement)); w = w.parent; }
    } catch (e) { /* cross-origin parent: stop */ }
    return chain;
  }

  /* ---------- where to look ---------- */
  // Every document and open shadow root reachable from the top page (same-origin frames only).
  function allRoots(doc) {
    const out = [];
    const visit = (r) => {
      out.push(r);
      const walker = (r.ownerDocument || r).createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.shadowRoot) visit(n.shadowRoot);
        if (n.tagName === 'IFRAME' || n.tagName === 'FRAME') {
          let d = null;
          try { d = n.contentDocument; } catch (e) { d = null; }
          if (d && d.documentElement) visit(d);
        }
      }
    };
    visit(doc || document);
    return out;
  }

  function q(r, sel) {
    try { return r.querySelector(sel); } catch (e) { return null; }
  }
  function qa(r, sel) {
    try { return [...r.querySelectorAll(sel)]; } catch (e) { return []; }
  }

  // The root the element lived in when it was recorded, if it still exists.
  function recordedRoot(sel) {
    let r = document;
    for (const f of sel.frame || []) {
      const fr = q(r, f);
      let d = null;
      try { d = fr && fr.contentDocument; } catch (e) { d = null; }
      if (!d) return null;
      r = d;
    }
    for (const h of sel.shadow || []) {
      const host = q(r, h);
      if (!host || !host.shadowRoot) return null;
      r = host.shadowRoot;
    }
    return r;
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function usable(el) {
    return visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  }

  function pageSpot(el) {
    const r = el.getBoundingClientRect();
    const w = el.ownerDocument.defaultView;
    return { x: Math.round(r.left + w.scrollX), y: Math.round(r.top + w.scrollY) };
  }

  /* ---------- describe ---------- */
  function byText(r, tag, role, text) {
    if (!text) return [];
    return qa(r, tag || '*').filter((e) => roleOf(e) === role && textOf(e) === text && visible(e));
  }
  function uniqueIn(r, sel) {
    return qa(r, sel).length === 1;
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const r = rootOf(el);
    const isField = /^(input|select|textarea)$/.test(tag) && !isButtonInput(el);
    const sel = {
      tag,
      testid: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test') || el.getAttribute('data-cy') || '',
      id: looksGenerated(el.id) ? '' : el.id,
      aria: norm(el.getAttribute('aria-label')),
      name: el.getAttribute('name') || '',
      role: roleOf(el),
      type: (el.getAttribute('type') || '').toLowerCase(),
      text: isField || el.isContentEditable ? '' : textOf(el),
      label: labelText(el),
      placeholder: norm(el.getAttribute('placeholder')).slice(0, 60),
      near: nearText(el),
      css: nthPath(el),
      pos: pageSpot(el),
      shadow: hostChain(el),
      frame: frameChain(el),
    };
    let key;
    if (sel.testid && uniqueIn(r, `[data-testid="${cssEsc(sel.testid)}"]`)) key = 'testid:' + sel.testid;
    else if (sel.id && uniqueIn(r, '#' + cssEsc(sel.id))) key = 'id:' + sel.id;
    else if (sel.aria && uniqueIn(r, `${tag}[aria-label="${cssEsc(sel.aria)}"]`)) key = 'aria:' + tag + ':' + sel.aria;
    else if (sel.name && uniqueIn(r, `${tag}[name="${cssEsc(sel.name)}"]`)) key = 'name:' + tag + ':' + sel.name;
    else if (sel.label && qa(r, tag).filter((e) => labelText(e) === sel.label).length === 1) key = 'label:' + tag + ':' + sel.label;
    else if (sel.placeholder && uniqueIn(r, `${tag}[placeholder="${cssEsc(sel.placeholder)}"]`)) key = 'placeholder:' + tag + ':' + sel.placeholder;
    else if (sel.text && byText(r, tag, sel.role, sel.text).length === 1) key = 'text:' + sel.role + ':' + sel.text;
    else key = 'css:' + sel.css;
    return { key, sel };
  }

  // Lists are found by structure only: their text changes as rows come and go, and their
  // DOM path can shift. A list without its own id is "the Nth <ul role=listbox> of <li>
  // inside the nearest stable ancestor".
  function stableAnchor(el) {
    for (let cur = el.parentElement; cur; cur = cur.parentElement) {
      const t = cur.getAttribute('data-testid');
      if (t) return `[data-testid="${cssEsc(t)}"]`;
      if (cur.id && !looksGenerated(cur.id)) return '#' + cssEsc(cur.id);
    }
    return '';
  }
  function listShape(el) {
    const role = el.getAttribute('role');
    return el.tagName.toLowerCase() + (role ? `[role="${cssEsc(role)}"]` : '');
  }
  function listCandidates(r, shape, anchor, itemSel) {
    const base = anchor ? q(r, anchor) : r;
    if (!base) return [];
    const all = qa(base, shape);
    const withItems = all.filter((c) => [...c.children].some((k) => k.matches(itemSel)));
    return withItems.length ? withItems : all;
  }
  function describeList(el, itemSel) {
    const r = rootOf(el);
    const sel = {
      tag: el.tagName.toLowerCase(),
      testid: el.getAttribute('data-testid') || el.getAttribute('data-test') || '',
      id: looksGenerated(el.id) ? '' : el.id,
      aria: norm(el.getAttribute('aria-label')),
      css: nthPath(el), shadow: hostChain(el), frame: frameChain(el),
      shape: listShape(el), anchor: stableAnchor(el), ordinal: 0,
    };
    sel.ordinal = Math.max(0, listCandidates(r, sel.shape, sel.anchor, itemSel).indexOf(el));
    let key;
    if (sel.testid && uniqueIn(r, `[data-testid="${cssEsc(sel.testid)}"]`)) key = 'testid:' + sel.testid;
    else if (sel.id && uniqueIn(r, '#' + cssEsc(sel.id))) key = 'id:' + sel.id;
    else if (sel.aria && uniqueIn(r, `${sel.tag}[aria-label="${cssEsc(sel.aria)}"]`)) key = 'aria:' + sel.tag + ':' + sel.aria;
    else key = 'shape:' + sel.shape + '>' + itemSel + '@' + sel.anchor + '#' + sel.ordinal;
    return { key, sel };
  }

  function findList(item) {
    const s = item.list.sel || {};
    if (!String(item.list.key).startsWith('shape:')) return resolve(item.list, { quick: true });
    for (const r of allRoots(document)) {
      const c = listCandidates(r, s.shape || s.tag, s.anchor, item.itemSel || '*');
      if (c.length) return c[Math.min(s.ordinal || 0, c.length - 1)];
    }
    return null;
  }

  /* ---------- lists (table rows, list items, repeated cards) ---------- */
  function itemSelector(el) {
    if (el.tagName === 'TR' || el.tagName === 'LI') return el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (role === 'row' || role === 'listitem') return '[role="' + role + '"]';
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
    return el.tagName.toLowerCase() + (cls && !looksGenerated(cls) ? '.' + cssEsc(cls) : '');
  }
  function siblingsLike(item, selector) {
    return [...item.parentElement.children].filter((c) => c.matches(selector));
  }
  function isListItem(el) {
    const p = el.parentElement;
    if (!p || p === el.ownerDocument.body || p === el.ownerDocument.documentElement) return false;
    const t = el.tagName;
    if (t === 'TR') return p.tagName !== 'THEAD';
    if (t === 'LI') return true;
    const role = el.getAttribute('role');
    if (role === 'row' || role === 'listitem') return true;
    const cls = el.getAttribute('class');
    if (!cls) return false;
    return siblingsLike(el, itemSelector(el)).length >= 3;
  }

  function cellsOf(item) {
    const text = (c) => norm(c.innerText || c.textContent).slice(0, 200);
    if (item.tagName === 'TR') return [...item.children].slice(0, 12).map(text);
    return [...item.querySelectorAll('*')].filter((e) => !e.children.length).map(text).filter(Boolean).slice(0, 12);
  }

  // If el sits inside a repeated item, describe that item and where el is inside it.
  function listItemOf(el) {
    let item = el;
    for (let d = 0; item && d < 7; d++, item = item.parentElement) {
      if (isListItem(item)) break;
    }
    if (!item || !isListItem(item)) return null;
    const selector = itemSelector(item);
    const sibs = siblingsLike(item, selector);
    const cell = item === el ? '' : nthPath(el, item);
    return {
      inner: innerKey(el, item, cell),
      list: describeList(item.parentElement, selector), itemSel: selector, index: sibs.indexOf(item), count: sibs.length, cell,
      isRow: item.tagName === 'TR' || item.getAttribute('role') === 'row',
      rowKey: norm(item.innerText || item.textContent).slice(0, 120), cells: cellsOf(item),
    };
  }

  // How to tell this element apart from its neighbors inside one row. Row data (names, links
  // with names) is never used, so "the same element in another row" has the same inner key.
  function innerKey(el, item, cell) {
    const inRow = (sel) => qa(item, sel).length === 1;
    const testid = el.getAttribute('data-testid') || el.getAttribute('data-test') || '';
    if (testid && inRow(`[data-testid="${cssEsc(testid)}"],[data-test="${cssEsc(testid)}"]`)) return 'testid:' + testid;
    if (el.id && !looksGenerated(el.id) && !/\d/.test(el.id)) return 'id:' + el.id;
    const tag = el.tagName.toLowerCase();
    const aria = norm(el.getAttribute('aria-label'));
    if (aria && inRow(`${tag}[aria-label="${cssEsc(aria)}"]`)) return 'aria:' + tag + ':' + aria;
    const name = el.getAttribute('name');
    if (name && inRow(`${tag}[name="${cssEsc(name)}"]`)) return 'name:' + tag + ':' + name;
    const label = labelText(el);
    if (label && qa(item, tag).filter((e) => labelText(e) === label).length === 1) return 'label:' + tag + ':' + label;
    const ph = norm(el.getAttribute('placeholder'));
    if (ph) return 'placeholder:' + tag + ':' + ph;
    if (roleOf(el) === 'button' && textOf(el)) return 'text:button:' + textOf(el);
    return 'cell:' + cell;
  }

  function listRows(item) {
    const list = findList(item);
    if (!list) return null;
    return [...list.children].filter((c) => c.matches(item.itemSel || '*'));
  }

  // The element for an item step in a given row ("last" or a number).
  function findInRow(item, row) {
    const rows = listRows(item);
    if (!rows) return { el: null, rows: null };
    const idx = row === 'last' ? rows.length - 1 : row;
    const itemEl = rows[idx];
    if (!itemEl) return { el: null, rows, missingRow: true };
    const el = item.cell ? q(itemEl, ':scope > ' + item.cell) : itemEl;
    return { el, rows, itemEl, rowKey: norm(itemEl.innerText || itemEl.textContent).slice(0, 120), cells: cellsOf(itemEl) };
  }

  /* ---------- resolve ---------- */
  function exactTries(r, s, first) {
    const order = ['testid', 'id', 'aria', 'name', 'label', 'placeholder', 'text', 'css'];
    order.sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
    const tag = s.tag || '*';
    const pick = {
      testid: () => s.testid && q(r, `[data-testid="${cssEsc(s.testid)}"],[data-test-id="${cssEsc(s.testid)}"],[data-test="${cssEsc(s.testid)}"],[data-cy="${cssEsc(s.testid)}"]`),
      id: () => s.id && r.getElementById && r.getElementById(s.id),
      aria: () => s.aria && q(r, `${tag}[aria-label="${cssEsc(s.aria)}"]`),
      name: () => s.name && q(r, `${tag}[name="${cssEsc(s.name)}"]`),
      label: () => s.label && qa(r, tag).find((e) => labelText(e) === s.label),
      placeholder: () => s.placeholder && q(r, `${tag}[placeholder="${cssEsc(s.placeholder)}"]`),
      text: () => s.text && byText(r, tag, s.role, s.text)[0],
      css: () => {
        const el = s.css && q(r, s.css);
        // A css path is only trusted when the element still looks like the one we recorded.
        const facts = [s.text, s.label, s.placeholder, s.aria].filter(Boolean);
        if (!el) return null;
        if (!facts.length) return (!s.role || roleOf(el) === s.role) && (!s.near || nearText(el) === s.near) ? el : null;
        const hits = [s.text && textOf(el) === s.text, s.label && labelText(el) === s.label,
          s.placeholder && norm(el.getAttribute('placeholder')) === s.placeholder, s.aria && norm(el.getAttribute('aria-label')) === s.aria];
        return hits.some(Boolean) ? el : null;
      },
    };
    return order.map((k) => pick[k]);
  }

  // Fallback: score every element of the same kind on what we know about it.
  function score(el, s) {
    let n = 0;
    if (s.testid && (el.getAttribute('data-testid') === s.testid || el.getAttribute('data-test') === s.testid)) n += 6;
    if (s.id && el.id === s.id) n += 5;
    if (s.aria && norm(el.getAttribute('aria-label')) === s.aria) n += 4;
    if (s.label && labelText(el) === s.label) n += 4;
    if (s.name && el.getAttribute('name') === s.name) n += 3;
    if (s.placeholder && norm(el.getAttribute('placeholder')) === s.placeholder) n += 3;
    if (s.text) { const t = textOf(el); if (t === s.text) n += 4; else if (t && (t.includes(s.text) || s.text.includes(t))) n += 1.5; }
    if (s.near && nearText(el) === s.near) n += 2;
    if (s.role && roleOf(el) === s.role) n += 1;
    if (s.type && (el.getAttribute('type') || '').toLowerCase() === s.type) n += 0.5;
    if (s.pos) {
      const p = pageSpot(el);
      const d = Math.hypot(p.x - s.pos.x, p.y - s.pos.y);
      if (d < 40) n += 2; else if (d < 200) n += 1;
    }
    return n;
  }

  function bestScored(roots, s) {
    let best = null, second = 0;
    for (const r of roots) {
      for (const el of qa(r, s.tag || '*')) {
        if (!usable(el)) continue;
        const n = score(el, s);
        if (!best || n > best.n) { second = best ? best.n : 0; best = { el, n }; }
        else if (n > second) second = n;
      }
    }
    // Needs real evidence (not just position and role) and a clear winner.
    if (best && best.n >= 4 && best.n - second >= 1) return best.el;
    return null;
  }

  function resolve(target, opts) {
    const s = (target && target.sel) || {};
    const first = String((target && target.key) || '').split(':')[0];
    const home = recordedRoot(s);
    const roots = home ? [home] : [];
    const everywhere = allRoots(document);
    for (const r of everywhere) if (!roots.includes(r)) roots.push(r);
    const ok = opts && opts.quick ? visible : usable;
    for (const r of roots) {
      for (const tryIt of exactTries(r, s, first)) {
        let el = null;
        try { el = tryIt(); } catch (e) { el = null; }
        if (el && ok(el)) return el;
      }
    }
    return bestScored(roots, s);
  }

  /* ---------- sensitive fields: never recorded, never typed into ---------- */
  function isSensitive(el) {
    if (!el || !el.tagName) return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/(^|\s)cc-|password|one-time-code/.test(ac)) return true;
    const hay = [el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), labelText(el), ac].join(' ');
    return S.SENSITIVE_WORDS.test(hay);
  }

  root.TabmateFinder = {
    norm, looksGenerated, roleOf, textOf, labelText, friendlyLabel, describe, resolve, visible, usable,
    listItemOf, listRows, findInRow, isSensitive, allRoots, cellsOf,
  };
})(typeof self !== 'undefined' ? self : globalThis);
