(function () {
  'use strict';
  const S = self.TabmateShared;
  const $ = (id) => document.getElementById(id);

  const L = self.TabmateLearn;

  let exportJson = '';

  async function render() {
    const { workflows = [] } = await chrome.storage.local.get('workflows');
    const bySite = {};
    for (const wf of workflows) (bySite[wf.site] = bySite[wf.site] || []).push(wf);
    const root = $('sites');
    root.textContent = '';
    $('empty').hidden = workflows.length > 0;
    const all = [];
    const taken = new Set();
    for (const [site, wfs] of Object.entries(bySite)) {
      const sec = document.createElement('section');
      sec.className = 'site';
      const h = document.createElement('h2');
      h.textContent = S.siteLabel(site);
      sec.append(h);
      for (const wf of wfs) {
        const tool = L.toTool(L.migrate(wf), taken);
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
