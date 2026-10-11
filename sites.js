// Shared site definitions. Loaded by the service worker (importScripts) and by content scripts.

const SITES = {
  crowdworks: {
    label: 'CrowdWorks',
    host: 'crowdworks.jp',
    defaultSearchUrl:
      'https://crowdworks.jp/public/jobs/search?order=new&price_min=50000&search%5Bexclude_keywords%5D=%E3%82%AF%E3%83%A9%E3%82%A6%E3%83%89%E3%83%AF%E3%83%BC%E3%82%AF%E3%82%B9+%E3%83%86%E3%83%83%E3%82%AF+%E5%8B%9F%E9%9B%86+PM+PMO+YouTube+Instagram',
    // Links on the search page that point to a job.
    listLinkSelector: 'a[href*="/public/jobs/"]',
    jobIdRe: /\/public\/jobs\/(\d+)(?:[/?#]|$)/,
    jobUrl: (id) => `https://crowdworks.jp/public/jobs/${id}`,
    // Proposal form opened directly, skipping the job page.
    proposeUrl: (id) => `https://crowdworks.jp/proposals/new?job_offer_id=${id}`,
    // Button / link on the job page that opens the proposal form (sites without proposeUrl).
    proposeButtonRe: /応募する|提案する/,
  },
  lancers: {
    label: 'Lancers',
    host: 'www.lancers.jp',
    defaultSearchUrl:
      'https://www.lancers.jp/work/search/system?open=1&search=%E6%A4%9C%E7%B4%A2&type%5B%5D=project&work_rank%5B%5D=0&work_rank%5B%5D=1&work_rank%5B%5D=2&work_rank%5B%5D=3',
    listLinkSelector: 'a.p-search-job-media__title, a[href*="/work/detail/"]',
    jobIdRe: /\/work\/detail\/(\d+)(?:[/?#]|$)/,
    jobUrl: (id) => `https://www.lancers.jp/work/detail/${id}`,
    proposeButtonRe: /提案する|見積もり.*提案/,
  },
  coconala: {
    label: 'Coconala',
    host: 'coconala.com',
    defaultSearchUrl: 'https://coconala.com/requests/categories/11',
    listLinkSelector: 'a[href*="/requests/"]',
    jobIdRe: /\/requests\/(\d+)(?:[/?#]|$)/,
    jobUrl: (id) => `https://coconala.com/requests/${id}`,
    proposeButtonRe: /提案する|見積もり.*提案/,
  },
};

// URL the bid tab opens first: the proposal form when the site has one, otherwise the job page.
function bidStartUrl(siteKey, id) {
  const site = SITES[siteKey];
  return site.proposeUrl ? site.proposeUrl(id) : site.jobUrl(id);
}

function siteKeyForHost(host) {
  return Object.keys(SITES).find((k) => SITES[k].host === host) || null;
}

const DEFAULT_TEMPLATE = `この度は、プロジェクトに応募する機会をいただき、誠にありがとうございます。

はじめまして。開発経験10年以上のフルスタックエンジニアです。Webサイト・ECサイト構築、業務システム開発、API連携、AIを活用したシステム開発など、幅広い開発経験がございます。要件を丁寧に理解し、品質・納期・コミュニケーションを大切にしながら、責任を持って最後まで対応することを心がけております。

現在、本プロジェクトの内容を詳しく確認し、最適なご提案ができるよう応募内容を準備しております。恐れ入りますが、提案の提出まで今しばらくお時間をいただけますと幸いです。

ご期待に沿える成果をご提供できるよう、誠心誠意取り組んでまいります。

何卒よろしくお願いいたします。`;

// Earlier built-in templates; a saved template still equal to one of these is upgraded to DEFAULT_TEMPLATE.
const LEGACY_TEMPLATES = [`はじめまして。
「{title}」の案件を拝見し、ご連絡いたしました。

（ここに自己紹介・実績・提案内容を記入してください）

ご検討のほど、よろしくお願いいたします。`];

const DEFAULT_SETTINGS = {
  running: false,
  intervalSec: 30,
  // false = fill the form and leave it open for you to review; true = press the final submit button.
  autoSubmit: false,
  // true = on Start, also queue the jobs already on the search page; false = only jobs posted after Start.
  bidExisting: false,
  maxPerHour: 10,
  maxPerDay: 30,
  includeKeywords: '',
  excludeKeywords: '',
  sites: Object.fromEntries(
    Object.entries(SITES).map(([key, s]) => [
      key,
      { enabled: true, searchUrl: s.defaultSearchUrl, template: DEFAULT_TEMPLATE, price: '', hourlyWage: '', hoursPerWeek: '', deliveryDays: 7 },
    ])
  ),
};

// Saved settings layered over the defaults (per site too), with outdated built-in templates upgraded.
function mergeSettings(saved) {
  const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  s.sites = {};
  for (const key of Object.keys(SITES)) {
    s.sites[key] = { ...DEFAULT_SETTINGS.sites[key], ...((saved && saved.sites && saved.sites[key]) || {}) };
    if (LEGACY_TEMPLATES.includes(s.sites[key].template)) s.sites[key].template = DEFAULT_TEMPLATE;
  }
  return s;
}
