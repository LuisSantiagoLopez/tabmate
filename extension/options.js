(function () {
  'use strict';
  const S = self.TabmateShared;
  const $ = (id) => document.getElementById(id);

  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'tool';

  function toTool(wf) {
    const properties = {};
    const notes = [];
    const used = new Set();
    wf.steps.forEach((st, i) => {
      if (st.kind !== 'input' && st.kind !== 'select' && st.kind !== 'check') return;
      if (st.sensitive) { notes.push('Step ' + (i + 1) + ' (' + st.label + ') is private and is filled by the user.'); return; }
      let key = slug(st.label);
      while (used.has(key)) key += '_' + (i + 1);
      used.add(key);
      properties[key] = st.kind === 'check'
        ? { type: 'boolean', description: st.label, default: !!st.value }
        : { type: 'string', description: st.label + (st.kind === 'select' ? ' (option value)' : ''), default: st.value == null ? '' : String(st.value) };
    });
    return {
      name: slug(wf.name),
      description: wf.name + '. ' + wf.steps.length + ' steps, learned by Tabmate.' + (notes.length ? ' ' + notes.join(' ') : ''),
      inputSchema: { type: 'object', properties, additionalProperties: false },
      annotations: { site: S.siteLabel(wf.site), startUrl: wf.steps[0] ? wf.steps[0].url : '', steps: wf.steps.map((s) => s.kind + ': ' + s.label) },
    };
  }

  let exportJson = '';

  async function render() {
    const { workflows = [] } = await chrome.storage.local.get('workflows');
    const bySite = {};
    for (const wf of workflows) (bySite[wf.site] = bySite[wf.site] || []).push(wf);
    const root = $('sites');
    root.textContent = '';
    $('empty').hidden = workflows.length > 0;
    const all = [];
    for (const [site, wfs] of Object.entries(bySite)) {
      const sec = document.createElement('section');
      sec.className = 'site';
      const h = document.createElement('h2');
      h.textContent = S.siteLabel(site);
      sec.append(h);
      for (const wf of wfs) {
        const tool = toTool(wf);
        all.push(tool);
        const card = document.createElement('div');
        card.className = 'tool';
        const n = document.createElement('p'); n.className = 'tool__name'; n.textContent = tool.name;
        const d = document.createElement('p'); d.className = 'tool__desc'; d.textContent = tool.description;
        const pre = document.createElement('pre'); pre.textContent = JSON.stringify(tool.inputSchema, null, 2);
        card.append(n, d, pre);
        sec.append(card);
      }
      root.append(sec);
    }
    exportJson = JSON.stringify({ tools: all }, null, 2);
  }

  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(exportJson); $('msg').textContent = 'Copied.'; }
    catch (e) { $('msg').textContent = 'Copy blocked by the browser. Use Download.'; }
  });
  $('download').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([exportJson], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'tabmate-tools.json';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('msg').textContent = 'Downloaded tabmate-tools.json.';
  });
  chrome.storage.onChanged.addListener(render);
  render();
})();
