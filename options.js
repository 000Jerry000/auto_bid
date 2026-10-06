const GENERAL_FIELDS = ['intervalSec', 'maxPerHour', 'maxPerDay', 'autoSubmit', 'bidExisting', 'includeKeywords', 'excludeKeywords'];

function readField(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') return el.value === '' ? '' : Number(el.value);
  return el.value;
}

function writeField(el, value) {
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value ?? '';
}

async function render() {
  const s = await loadSettings();
  for (const f of GENERAL_FIELDS) writeField(document.getElementById(f), s[f]);

  const container = document.getElementById('sites');
  const tpl = document.getElementById('siteTpl');
  container.replaceChildren();
  for (const [key, site] of Object.entries(SITES)) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.site = key;
    node.querySelector('[data-label]').textContent = site.label;
    for (const el of node.querySelectorAll('[data-f]')) writeField(el, s.sites[key][el.dataset.f]);
    container.append(node);
  }
  renderStatus(s);
}

async function save() {
  const s = await loadSettings();
  for (const f of GENERAL_FIELDS) s[f] = readField(document.getElementById(f));
  s.intervalSec = Math.max(30, Number(s.intervalSec) || 30);
  s.maxPerHour = Math.max(1, Number(s.maxPerHour) || 1);
  s.maxPerDay = Math.max(1, Number(s.maxPerDay) || 1);
  for (const node of document.querySelectorAll('#sites [data-site]')) {
    const key = node.dataset.site;
    for (const el of node.querySelectorAll('[data-f]')) s.sites[key][el.dataset.f] = readField(el);
  }
  await chrome.storage.local.set({ settings: s });
  writeField(document.getElementById('intervalSec'), s.intervalSec);
  const saved = document.getElementById('saved');
  saved.textContent = 'Saved.';
  setTimeout(() => (saved.textContent = ''), 2000);
}

async function refreshLog() {
  const { log } = await chrome.storage.local.get('log');
  renderLog(document.getElementById('log'), log, 300);
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('resetSeen').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'resetSeen' }));
document.getElementById('clearLog').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'clearLog' }));
bindToggle();

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.log) refreshLog();
  if (changes.settings) renderStatus(await loadSettings());
});

render();
refreshLog();
