async function refresh() {
  const s = await loadSettings();
  const { log, queue = [], bidTimes = [], current } = await chrome.storage.local.get(['log', 'queue', 'bidTimes', 'current']);
  renderStatus(s);
  const today = bidTimes.filter((t) => Date.now() - t < 24 * 3600 * 1000).length;
  document.getElementById('stats').textContent =
    `Bids last 24h: ${today}/${s.maxPerDay} · queued: ${queue.length}` + (current ? ` · bidding: ${current.task.title}` : '');
  renderLog(document.getElementById('log'), log, 12);
}

bindToggle();
document.getElementById('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener((_, area) => area === 'local' && refresh());
refresh();
