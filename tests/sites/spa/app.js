/* A small React SPA built to be hard on Tabmate:
   - every id and class is random on each load (no stable selectors),
   - a random number of wrapper divs shifts the DOM paths,
   - the form renders late (700 ms "loading"), the dropdown options later still,
   - controlled inputs (React state), a custom dropdown (role=listbox), a contenteditable,
     a web component with an open shadow root, a same-origin iframe, and a Ctrl+Enter shortcut. */
(function () {
  'use strict';
  const h = React.createElement;
  const rnd = (p) => p + '-' + Math.random().toString(36).slice(2, 7) + Math.floor(10 + Math.random() * 89);
  const asked = new URLSearchParams(location.search).get('sp');
  const SPACERS = asked != null ? Number(asked) : Math.floor(Math.random() * 3);

  class TagBox extends HTMLElement {
    constructor() {
      super();
      const sr = this.attachShadow({ mode: 'open' });
      sr.innerHTML = '<input placeholder="Add tag" class="' + rnd('t') + '"> <button type="button">Add</button>';
    }
    get value() { return this.shadowRoot.querySelector('input').value; }
  }
  customElements.define('tag-box', TagBox);

  function Spacers() {
    return h(React.Fragment, null, Array.from({ length: SPACERS }, (_, i) => h('div', { key: i, className: rnd('s') })));
  }

  function Plan({ value, onChange }) {
    const [open, setOpen] = React.useState(false);
    const [ready, setReady] = React.useState(false);
    const id = React.useMemo(() => rnd('plan'), []);
    React.useEffect(() => { if (open) { const t = setTimeout(() => setReady(true), 350); return () => clearTimeout(t); } setReady(false); }, [open]);
    return h('div', { className: 'field' },
      h('span', { id: id + 'l' }, 'Plan '),
      h('button', { type: 'button', id, 'aria-haspopup': 'listbox', 'aria-labelledby': id + 'l', onClick: () => setOpen(!open) }, value || 'Choose plan'),
      open && ready && h('ul', { role: 'listbox', className: rnd('lb') },
        ['Free', 'Pro', 'Team'].map((p) => h('li', { key: p, role: 'option', id: rnd('o'), onClick: () => { onChange(p); setOpen(false); } }, p))));
  }

  function Form({ onSave }) {
    const [name, setName] = React.useState('');
    const [plan, setPlan] = React.useState('');
    const notes = React.useRef(null);
    const tags = React.useRef(null);
    const frame = React.useRef(null);
    const nameId = React.useMemo(() => rnd('f'), []);
    const save = React.useCallback(() => {
      const doc = frame.current && frame.current.contentDocument;
      onSave({ name, plan, notes: notes.current.innerText.trim(), tag: tags.current.value, agreed: !!(doc && doc.getElementById('agree').checked) });
    }, [name, plan, onSave]);
    React.useEffect(() => {
      const onKey = (e) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); save(); } };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [save]);
    return h('form', { className: rnd('form'), onSubmit: (e) => e.preventDefault() },
      h(Spacers),
      h('div', { className: 'field' }, h('label', { htmlFor: nameId }, 'Full name'), ' ',
        h('input', { id: nameId, className: rnd('in'), value: name, onChange: (e) => setName(e.target.value) })),
      h(Plan, { value: plan, onChange: setPlan }),
      h('div', { className: 'field' }, h('iframe', { ref: frame, src: 'terms.html', title: 'Terms' })),
      h('div', { className: 'field' }, h('span', null, 'Tag'), ' ', h('tag-box', { ref: tags })),
      h('div', { className: 'field' }, h('div', { className: rnd('lbl') }, 'Notes'), h('div', { ref: notes, className: 'notes ' + rnd('n'), contentEditable: true, suppressContentEditableWarning: true })),
      h('p', null, 'Press Ctrl+Enter to save'));
  }

  function App() {
    const [mode, setMode] = React.useState('list');
    const [saved, setSaved] = React.useState(() => JSON.parse(localStorage.getItem('spa-contacts') || '[]'));
    const open = () => { setMode('loading'); setTimeout(() => setMode('form'), 700); };
    const onSave = React.useCallback((c) => {
      setSaved((s) => { const n = s.concat(c); localStorage.setItem('spa-contacts', JSON.stringify(n)); return n; });
      setMode('list');
    }, []);
    return h('main', { className: rnd('app') },
      h('h1', null, 'Contacts'),
      h(Spacers),
      h('button', { type: 'button', id: rnd('new'), className: rnd('b'), onClick: open }, 'New contact'),
      mode === 'loading' && h('p', null, 'Loading…'),
      mode === 'form' && h(Form, { onSave }),
      h('ul', { id: 'saved' }, saved.map((c, i) => h('li', { key: i }, [c.name, c.plan, c.notes, c.tag, c.agreed ? 'agreed' : 'not agreed'].join(' · ')))));
  }

  ReactDOM.createRoot(document.getElementById('root')).render(h(App));
})();
