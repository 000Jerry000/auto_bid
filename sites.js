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
    // Button / link on the job page that opens the proposal form.
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

function siteKeyForHost(host) {
  return Object.keys(SITES).find((k) => SITES[k].host === host) || null;
}

const DEFAULT_TEMPLATE = `はじめまして。
「{title}」の案件を拝見し、ご連絡いたしました。

（ここに自己紹介・実績・提案内容を記入してください）

ご検討のほど、よろしくお願いいたします。`;

const DEFAULT_SETTINGS = {
  running: false,
  intervalSec: 30,
  // false = fill the form and leave it open for you to review; true = press the final submit button.
  autoSubmit: false,
  maxPerHour: 10,
  maxPerDay: 30,
  includeKeywords: '',
  excludeKeywords: '',
  sites: Object.fromEntries(
    Object.entries(SITES).map(([key, s]) => [
      key,
      { enabled: true, searchUrl: s.defaultSearchUrl, template: DEFAULT_TEMPLATE, price: '', deliveryDays: 7 },
    ])
  ),
};
