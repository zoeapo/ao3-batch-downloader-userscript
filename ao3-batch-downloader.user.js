// ==UserScript==
// @name         AO3 批量作品下载器
// @namespace    https://github.com/zoeapo/ao3-batch-downloader-userscript
// @version      0.1.0
// @description  扫描 AO3 列表的全部分页，筛选作品，并批量下载 AO3 官方 EPUB 和 PDF 文件。
// @author       zoeapo
// @license      GPL-3.0-only
// @match        https://archiveofourown.org/*
// @match        https://www.archiveofourown.org/*
// @match        https://archiveofourown.com/*
// @match        https://archiveofourown.net/*
// @match        https://archiveofourown.gay/*
// @match        https://ao3.org/*
// @match        https://archive.transformativeworks.org/*
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      archiveofourown.org
// @connect      www.archiveofourown.org
// @connect      download.archiveofourown.org
// @connect      archiveofourown.com
// @connect      archiveofourown.net
// @connect      archiveofourown.gay
// @connect      ao3.org
// @connect      archive.transformativeworks.org
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * 本脚本是面向浏览器的独立重写，功能设计参考：
 * https://github.com/nianeyna/ao3downloader
 *
 * 本项目与 Archive of Our Own、OTW 以及原 ao3downloader 作者无隶属关系。
 */

(() => {
  'use strict';

  const APP_NAME = 'AO3 批量作品下载器';
  const APP_VERSION = '0.1.0';
  const STORAGE_SETTINGS = 'ao3bd.settings.v1';
  const STORAGE_RECORDS = 'ao3bd.records.v1';
  const STORAGE_LAST_TASK = 'ao3bd.lastTask.v1';
  const MAX_PAGE_SAFETY_LIMIT = 10000;

  const DEFAULT_SETTINGS = Object.freeze({
    formats: ['EPUB', 'PDF'],
    skipDownloaded: true,
    scanDelaySeconds: 2,
    workDelaySeconds: 3,
    formatDelaySeconds: 1,
    completion: 'all',
    minWords: '',
    maxWords: '',
    ratings: [],
    categories: [],
    languages: '',
    fandoms: '',
    relationships: '',
    characters: '',
    additionalTags: '',
    excludeWarnings: '',
    excludeRelationships: '',
    excludeCharacters: '',
    excludeAdditionalTags: '',
    includeMode: 'any',
    tagMatchMode: 'exact',
  });

  const runtime = {
    panelOpen: false,
    scanning: false,
    running: false,
    paused: false,
    stopped: false,
    works: [],
    filteredWorks: [],
    sourceUrl: '',
    scannedPages: 0,
    currentIndex: 0,
    stats: {
      discovered: 0,
      filtered: 0,
      success: 0,
      failed: 0,
      skipped: 0,
    },
    activeDownloads: new Set(),
    logs: [],
  };

  const ui = {};

  const RATING_OPTIONS = [
    'General Audiences',
    'Teen And Up Audiences',
    'Mature',
    'Explicit',
    'Not Rated',
  ];

  const CATEGORY_OPTIONS = ['F/F', 'F/M', 'Gen', 'M/M', 'Multi', 'Other'];

  function cloneDefaultSettings() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  function loadSettings() {
    const stored = GM_getValue(STORAGE_SETTINGS, {});
    return {
      ...cloneDefaultSettings(),
      ...(stored && typeof stored === 'object' ? stored : {}),
    };
  }

  function saveSettings(settings) {
    GM_setValue(STORAGE_SETTINGS, settings);
  }

  function loadRecords() {
    const records = GM_getValue(STORAGE_RECORDS, {});
    return records && typeof records === 'object' ? records : {};
  }

  function saveRecords(records) {
    GM_setValue(STORAGE_RECORDS, records);
  }

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase();
  }

  function parseTerms(value) {
    return String(value ?? '')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function parseNonNegativeNumber(value) {
    const cleaned = String(value ?? '').replace(/,/g, '').trim();
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  function unique(values) {
    return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))];
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function interruptibleSleep(milliseconds) {
    const end = Date.now() + Math.max(0, milliseconds);
    while (Date.now() < end) {
      if (runtime.stopped) throw new Error('任务已停止');
      await waitWhilePaused();
      await sleep(Math.min(500, end - Date.now()));
    }
  }

  async function waitWhilePaused() {
    while (runtime.paused && !runtime.stopped) {
      await sleep(250);
    }
    if (runtime.stopped) throw new Error('任务已停止');
  }

  function formatClock(date = new Date()) {
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function log(message, level = 'info') {
    const entry = { time: formatClock(), message: String(message), level };
    runtime.logs.push(entry);
    if (runtime.logs.length > 400) runtime.logs.shift();

    if (ui.log) {
      const line = document.createElement('div');
      line.className = `ao3bd-log-line ao3bd-log-${level}`;
      line.textContent = `[${entry.time}] ${entry.message}`;
      ui.log.appendChild(line);
      while (ui.log.childElementCount > 400) ui.log.firstElementChild?.remove();
      ui.log.scrollTop = ui.log.scrollHeight;
    }
  }

  function setStatus(message) {
    if (ui.status) ui.status.textContent = message;
  }

  function updateStats() {
    runtime.stats.discovered = runtime.works.length;
    runtime.stats.filtered = runtime.filteredWorks.length;

    if (ui.statPages) ui.statPages.textContent = String(runtime.scannedPages);
    if (ui.statDiscovered) ui.statDiscovered.textContent = String(runtime.stats.discovered);
    if (ui.statFiltered) ui.statFiltered.textContent = String(runtime.stats.filtered);
    if (ui.statSuccess) ui.statSuccess.textContent = String(runtime.stats.success);
    if (ui.statFailed) ui.statFailed.textContent = String(runtime.stats.failed);
    if (ui.statSkipped) ui.statSkipped.textContent = String(runtime.stats.skipped);
    if (ui.progressText) {
      const total = runtime.filteredWorks.length;
      ui.progressText.textContent = `${Math.min(runtime.currentIndex, total)} / ${total}`;
    }
    if (ui.progressBar) {
      const total = runtime.filteredWorks.length;
      const percentage = total > 0 ? Math.min(100, (runtime.currentIndex / total) * 100) : 0;
      ui.progressBar.style.width = `${percentage}%`;
    }
  }

  function setBusyState() {
    const busy = runtime.scanning || runtime.running;
    if (ui.scanButton) ui.scanButton.disabled = busy;
    if (ui.applyFilterButton) ui.applyFilterButton.disabled = busy || runtime.works.length === 0;
    if (ui.startButton) ui.startButton.disabled = busy || runtime.filteredWorks.length === 0;
    if (ui.pauseButton) {
      ui.pauseButton.disabled = !runtime.running;
      ui.pauseButton.textContent = runtime.paused ? '继续' : '暂停';
    }
    if (ui.stopButton) ui.stopButton.disabled = !busy;
    if (ui.exportFilteredButton) ui.exportFilteredButton.disabled = runtime.filteredWorks.length === 0;
    if (ui.exportAllButton) ui.exportAllButton.disabled = runtime.works.length === 0;
  }

  function getOriginForAo3() {
    return window.location.origin;
  }

  function extractWorkId(value) {
    const text = String(value ?? '');
    const match = text.match(/\/works\/(\d+)/i)
      || text.match(/(?:^|\s)work[-_](\d+)(?:\s|$)/i)
      || text.match(/\bwork_(\d+)\b/i);
    return match ? match[1] : null;
  }

  function canonicalWorkUrl(workId) {
    return `${getOriginForAo3()}/works/${workId}`;
  }

  function buildStartUrl() {
    const current = new URL(window.location.href);
    current.hash = '';

    const workId = extractWorkId(current.pathname);
    if (workId) return canonicalWorkUrl(workId);

    current.searchParams.delete('page');
    return current.href;
  }

  function resolveUrl(href, baseUrl) {
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return null;
    }
  }

  function parseRetryAfter(value) {
    if (!value) return 300;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return Math.max(1, Math.ceil((timestamp - Date.now()) / 1000));
    return 300;
  }

  function looksLikeCloudflare(text) {
    const lower = String(text).toLowerCase();
    return [
      '<title>just a moment...</title>',
      '<title>attention required!</title>',
      '<title>access denied</title>',
      'cf-browser-verification',
      'id="challenge-error-text"',
      'id="cf-wrapper"',
      '_cf_chl_opt',
    ].some((marker) => lower.includes(marker));
  }

  async function requestText(url, label = '页面') {
    let attempt = 0;
    let timeoutCount = 0;

    while (true) {
      await waitWhilePaused();
      if (runtime.stopped) throw new Error('任务已停止');

      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 60000);

      try {
        const response = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });
        window.clearTimeout(timer);
        timeoutCount = 0;

        if (response.status === 429) {
          const pauseSeconds = parseRetryAfter(response.headers.get('Retry-After'));
          log(`AO3 要求暂停请求，等待 ${pauseSeconds} 秒。`, 'warn');
          setStatus(`请求受限，等待 ${pauseSeconds} 秒`);
          await interruptibleSleep(pauseSeconds * 1000);
          continue;
        }

        if ([500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530].includes(response.status)) {
          if (attempt >= 5) throw new Error(`${label}请求失败：HTTP ${response.status}`);
          const delay = Math.min(30000, 500 * (2 ** attempt));
          attempt += 1;
          log(`${label}暂时不可用，${Math.ceil(delay / 1000)} 秒后重试（${attempt}/5）。`, 'warn');
          await interruptibleSleep(delay);
          continue;
        }

        if (!response.ok) {
          throw new Error(`${label}请求失败：HTTP ${response.status}`);
        }

        const text = await response.text();
        if (looksLikeCloudflare(text)) {
          if (attempt >= 5) throw new Error(`${label}被 Cloudflare 验证页阻止`);
          const delay = Math.min(30000, 1000 * (2 ** attempt));
          attempt += 1;
          log(`遇到 Cloudflare 验证页，${Math.ceil(delay / 1000)} 秒后重试（${attempt}/5）。`, 'warn');
          await interruptibleSleep(delay);
          continue;
        }

        return { text, finalUrl: response.url || url };
      } catch (error) {
        window.clearTimeout(timer);
        if (runtime.stopped) throw new Error('任务已停止');

        if (error?.name === 'AbortError') {
          timeoutCount += 1;
          if (timeoutCount >= 3) throw new Error(`${label}连续超时 3 次`);
          log(`${label}请求超时，准备重试（${timeoutCount}/3）。`, 'warn');
          await interruptibleSleep(1500 * timeoutCount);
          continue;
        }

        if (attempt >= 5) throw error;
        const delay = Math.min(30000, 500 * (2 ** attempt));
        attempt += 1;
        log(`${label}请求出错：${error.message}。稍后重试（${attempt}/5）。`, 'warn');
        await interruptibleSleep(delay);
      }
    }
  }

  function parseHtml(text) {
    return new DOMParser().parseFromString(text, 'text/html');
  }

  async function requestDocument(url, label) {
    const result = await requestText(url, label);
    return { document: parseHtml(result.text), finalUrl: result.finalUrl };
  }

  function getText(node, selector) {
    const element = node.querySelector(selector);
    return element ? element.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function getTexts(node, selector) {
    return unique([...node.querySelectorAll(selector)]
      .map((element) => element.textContent.replace(/\s+/g, ' ').trim())
      .filter(Boolean));
  }

  function getAccessibleLabel(element) {
    if (!element) return '';
    const candidates = [
      element.getAttribute('title'),
      element.getAttribute('aria-label'),
      element.textContent,
      element.className,
      element.parentElement?.getAttribute('title'),
      element.parentElement?.className,
    ];
    return candidates.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function normalizeRating(raw) {
    const text = normalizeText(raw);
    if (!text) return '';
    if (text.includes('general audiences') || text.includes('rating-general-audience')) return 'General Audiences';
    if (text.includes('teen and up') || text.includes('rating-teen')) return 'Teen And Up Audiences';
    if (text.includes('explicit') || text.includes('rating-explicit')) return 'Explicit';
    if (text.includes('mature') || text.includes('rating-mature')) return 'Mature';
    if (text.includes('not rated') || text.includes('rating-notrated')) return 'Not Rated';
    return raw.replace(/\s+/g, ' ').trim();
  }

  function normalizeCategories(rawValues) {
    const result = [];
    for (const raw of rawValues) {
      const text = `${raw} ${normalizeText(raw)}`;
      if (/\bF\/F\b/i.test(raw) || text.includes('category-femslash')) result.push('F/F');
      if (/\bF\/M\b/i.test(raw) || text.includes('category-het')) result.push('F/M');
      if (/\bM\/M\b/i.test(raw) || text.includes('category-slash')) result.push('M/M');
      if (/\bGen\b/i.test(raw) || text.includes('category-gen')) result.push('Gen');
      if (/\bMulti\b/i.test(raw) || text.includes('category-multi')) result.push('Multi');
      if (/\bOther\b/i.test(raw) || text.includes('category-other')) result.push('Other');
    }
    return unique(result);
  }

  function parseChapterStats(text) {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
    const match = normalized.match(/([\d,]+)\s*\/\s*([\d,?]+)/);
    if (!match) return { current: null, total: null, complete: null };
    const current = Number(match[1].replace(/,/g, ''));
    const total = match[2] === '?' ? null : Number(match[2].replace(/,/g, ''));
    return {
      current: Number.isFinite(current) ? current : null,
      total: Number.isFinite(total) ? total : null,
      complete: Number.isFinite(current) && Number.isFinite(total) ? current === total : false,
    };
  }

  function detectCompletionFromBlurb(node) {
    const marker = node.querySelector(
      'span.iswip, li.iswip span, li.complete span, li.incomplete span, .required-tags .iswip span',
    );
    const label = normalizeText(getAccessibleLabel(marker));
    if (label.includes('complete work') || label.includes('complete-yes')) return true;
    if (label.includes('work in progress') || label.includes('incomplete') || label.includes('complete-no')) return false;

    const chapterText = getText(node, 'dd.chapters');
    return parseChapterStats(chapterText).complete;
  }

  function findWorkLink(node, baseUrl) {
    const selectors = [
      'h4.heading a[href*="/works/"]',
      'a[href*="/works/"]',
    ];
    for (const selector of selectors) {
      const anchors = [...node.querySelectorAll(selector)];
      for (const anchor of anchors) {
        const workId = extractWorkId(anchor.getAttribute('href'));
        if (workId) return { workId, url: canonicalWorkUrl(workId), anchor };
      }
    }

    const workId = extractWorkId(`${node.id} ${node.className}`);
    return workId ? { workId, url: canonicalWorkUrl(workId), anchor: null } : null;
  }

  function parseWorkBlurb(node, baseUrl) {
    const workLink = findWorkLink(node, baseUrl);
    if (!workLink) return null;

    const titleAnchor = node.querySelector('h4.heading a[href*="/works/"]') || workLink.anchor;
    const ratingElement = node.querySelector(
      'span.rating, li.rating span, .required-tags li.rating span, .required-tags .rating span',
    );
    const categoryElements = [...node.querySelectorAll(
      'span.category, li.category span, .required-tags li.category span, .required-tags .category span',
    )];

    const words = parseNonNegativeNumber(getText(node, 'dd.words'));
    const chapterText = getText(node, 'dd.chapters');
    const chapters = parseChapterStats(chapterText);

    return {
      id: workLink.workId,
      url: workLink.url,
      sourceUrl: baseUrl,
      title: titleAnchor?.textContent.replace(/\s+/g, ' ').trim() || `作品 ${workLink.workId}`,
      authors: getTexts(node, 'a[rel="author"]'),
      fandoms: getTexts(node, 'h5.fandoms a, li.fandoms a, dd.fandom a'),
      warnings: getTexts(node, 'li.warnings a, dd.warning a'),
      relationships: getTexts(node, 'li.relationships a, dd.relationship a'),
      characters: getTexts(node, 'li.characters a, dd.character a'),
      additionalTags: getTexts(node, 'li.freeforms a, dd.freeform a'),
      rating: normalizeRating(getAccessibleLabel(ratingElement)),
      categories: normalizeCategories(categoryElements.map(getAccessibleLabel)),
      words,
      chapterText,
      currentChapters: chapters.current,
      totalChapters: chapters.total,
      complete: detectCompletionFromBlurb(node),
      language: getText(node, 'dd.language'),
      updated: getText(node, 'div.header p.datetime, p.datetime'),
      metadataSource: 'list',
    };
  }

  function getWorkNodes(doc) {
    const selectors = [
      'li.work.blurb.group',
      'li[id^="work_"]',
      'li[class*="work-"]',
      '.work.blurb.group',
      'li.bookmark.blurb.group',
    ];
    const seen = new Set();
    const nodes = [];

    for (const selector of selectors) {
      for (const node of doc.querySelectorAll(selector)) {
        if (seen.has(node)) continue;
        seen.add(node);
        nodes.push(node);
      }
    }
    return nodes;
  }

  function parseWorksFromList(doc, pageUrl) {
    const worksById = new Map();
    for (const node of getWorkNodes(doc)) {
      const work = parseWorkBlurb(node, pageUrl);
      if (work && !worksById.has(work.id)) worksById.set(work.id, work);
    }

    // 部分 AO3 页面（例如订阅列表）只有作品链接，没有完整 blurb。
    // 这里补充收集数字作品链接，筛选字段缺失时保持为空。
    for (const anchor of doc.querySelectorAll('.index.group a[href*="/works/"], #main a[href*="/works/"]')) {
      const workId = extractWorkId(anchor.getAttribute('href'));
      if (!workId || worksById.has(workId)) continue;
      worksById.set(workId, {
        id: workId,
        url: canonicalWorkUrl(workId),
        sourceUrl: pageUrl,
        title: anchor.textContent.replace(/\s+/g, ' ').trim() || `作品 ${workId}`,
        authors: [],
        fandoms: [],
        warnings: [],
        relationships: [],
        characters: [],
        additionalTags: [],
        rating: '',
        categories: [],
        words: null,
        chapterText: '',
        currentChapters: null,
        totalChapters: null,
        complete: null,
        language: '',
        updated: '',
        metadataSource: 'link',
      });
    }

    return [...worksById.values()];
  }

  function parseWorkPage(doc, workUrl) {
    const workId = extractWorkId(workUrl) || extractWorkId(doc.querySelector('link[rel="canonical"]')?.href);
    if (!workId) return null;

    const chapterText = getText(doc, 'dl.stats dd.chapters, dd.chapters');
    const chapters = parseChapterStats(chapterText);
    const rating = normalizeRating(getText(doc, 'dd.rating'));

    return {
      id: workId,
      url: canonicalWorkUrl(workId),
      sourceUrl: workUrl,
      title: getText(doc, '#workskin .preface .title, .preface .title') || `作品 ${workId}`,
      authors: getTexts(doc, '#workskin .preface .byline a[rel="author"], .preface .byline a[rel="author"]'),
      fandoms: getTexts(doc, 'dd.fandom a'),
      warnings: getTexts(doc, 'dd.warning a'),
      relationships: getTexts(doc, 'dd.relationship a'),
      characters: getTexts(doc, 'dd.character a'),
      additionalTags: getTexts(doc, 'dd.freeform a'),
      rating,
      categories: normalizeCategories(getTexts(doc, 'dd.category a, dd.category')),
      words: parseNonNegativeNumber(getText(doc, 'dd.words')),
      chapterText,
      currentChapters: chapters.current,
      totalChapters: chapters.total,
      complete: chapters.complete,
      language: getText(doc, 'dd.language'),
      updated: getText(doc, 'dd.status'),
      metadataSource: 'work',
    };
  }

  function mergeWorkMetadata(base, detailed) {
    if (!detailed) return base;
    const arrayFields = ['authors', 'fandoms', 'warnings', 'relationships', 'characters', 'additionalTags', 'categories'];
    const merged = { ...base };

    for (const field of arrayFields) {
      if (Array.isArray(detailed[field]) && detailed[field].length) merged[field] = detailed[field];
    }

    for (const field of [
      'title', 'rating', 'words', 'chapterText', 'currentChapters', 'totalChapters',
      'complete', 'language', 'updated', 'metadataSource',
    ]) {
      if (detailed[field] !== '' && detailed[field] !== null && detailed[field] !== undefined) {
        merged[field] = detailed[field];
      }
    }
    return merged;
  }

  function getNextPageUrl(doc, currentUrl) {
    const next = doc.querySelector(
      'ol.pagination li.next a, .pagination li.next a, a[rel="next"]',
    );
    if (!next) return null;
    return resolveUrl(next.getAttribute('href'), currentUrl);
  }

  function isLoginPage(doc) {
    return Boolean(doc.querySelector('body.logged-out #new_user, form#new_user, div#main.sessions-new'));
  }

  function isDeletedPage(doc) {
    return Boolean(doc.querySelector('div#main.error-404, .error-404'));
  }

  function isHiddenWorkPage(doc) {
    const notice = doc.querySelector('p.notice');
    return Boolean(notice?.querySelector('a[href^="/collections/"]'));
  }

  function getProceedUrl(doc, baseUrl) {
    const links = [...doc.querySelectorAll('div.works-show.region ul.actions li a, .caution a')];
    const proceed = links.find((anchor) => normalizeText(anchor.textContent) === 'proceed');
    return proceed ? resolveUrl(proceed.getAttribute('href'), baseUrl) : null;
  }

  function addAdultViewParameter(url) {
    const parsed = new URL(url);
    parsed.searchParams.set('view_adult', 'true');
    return parsed.href;
  }

  async function loadWorkDocument(work) {
    const initialUrl = addAdultViewParameter(work.url);
    let result = await requestDocument(initialUrl, `作品 ${work.id}`);
    let doc = result.document;
    let finalUrl = result.finalUrl;

    if (isLoginPage(doc)) throw new Error('作品需要登录 AO3 后访问');
    if (isDeletedPage(doc)) throw new Error('作品已删除或链接无效');
    if (isHiddenWorkPage(doc)) throw new Error('作品位于不可访问的隐藏合集');

    const proceedUrl = getProceedUrl(doc, finalUrl);
    if (proceedUrl && !doc.querySelector('li.download a')) {
      result = await requestDocument(proceedUrl, `作品 ${work.id} 成人内容确认`);
      doc = result.document;
      finalUrl = result.finalUrl;
    }

    if (isLoginPage(doc)) throw new Error('作品需要登录 AO3 后访问');
    if (isDeletedPage(doc)) throw new Error('作品已删除或链接无效');

    return { document: doc, finalUrl };
  }

  function getDownloadLinks(doc, baseUrl) {
    const links = {};
    for (const anchor of doc.querySelectorAll('li.download a, ul.download a')) {
      const label = anchor.textContent.replace(/\s+/g, ' ').trim().toUpperCase();
      if (label === 'EPUB' || label === 'PDF') {
        const resolved = resolveUrl(anchor.getAttribute('href'), baseUrl);
        if (resolved) links[label] = resolved;
      }
    }
    return links;
  }

  function matchesOneValue(value, term, mode) {
    const normalizedValue = normalizeText(value);
    const normalizedTerm = normalizeText(term);
    if (!normalizedValue || !normalizedTerm) return false;
    return mode === 'contains'
      ? normalizedValue.includes(normalizedTerm)
      : normalizedValue === normalizedTerm;
  }

  function matchesIncludedField(values, terms, includeMode, matchMode) {
    if (!terms.length) return true;
    const normalizedValues = Array.isArray(values) ? values : [values];
    const predicate = (term) => normalizedValues.some((value) => matchesOneValue(value, term, matchMode));
    return includeMode === 'all' ? terms.every(predicate) : terms.some(predicate);
  }

  function hitsExcludedField(values, terms, matchMode) {
    if (!terms.length) return false;
    const normalizedValues = Array.isArray(values) ? values : [values];
    return terms.some((term) => normalizedValues.some((value) => matchesOneValue(value, term, matchMode)));
  }

  function workMatchesFilters(work, settings) {
    if (settings.completion === 'complete' && work.complete !== true) return false;
    if (settings.completion === 'incomplete' && work.complete !== false) return false;

    const minWords = parseNonNegativeNumber(settings.minWords);
    const maxWords = parseNonNegativeNumber(settings.maxWords);
    if (minWords !== null && (work.words === null || work.words < minWords)) return false;
    if (maxWords !== null && (work.words === null || work.words > maxWords)) return false;

    if (settings.ratings.length && !settings.ratings.includes(work.rating)) return false;
    if (settings.categories.length && !work.categories.some((category) => settings.categories.includes(category))) return false;

    const languageTerms = parseTerms(settings.languages);
    if (!matchesIncludedField([work.language], languageTerms, settings.includeMode, settings.tagMatchMode)) return false;

    if (!matchesIncludedField(work.fandoms, parseTerms(settings.fandoms), settings.includeMode, settings.tagMatchMode)) return false;
    if (!matchesIncludedField(work.relationships, parseTerms(settings.relationships), settings.includeMode, settings.tagMatchMode)) return false;
    if (!matchesIncludedField(work.characters, parseTerms(settings.characters), settings.includeMode, settings.tagMatchMode)) return false;
    if (!matchesIncludedField(work.additionalTags, parseTerms(settings.additionalTags), settings.includeMode, settings.tagMatchMode)) return false;

    if (hitsExcludedField(work.warnings, parseTerms(settings.excludeWarnings), settings.tagMatchMode)) return false;
    if (hitsExcludedField(work.relationships, parseTerms(settings.excludeRelationships), settings.tagMatchMode)) return false;
    if (hitsExcludedField(work.characters, parseTerms(settings.excludeCharacters), settings.tagMatchMode)) return false;
    if (hitsExcludedField(work.additionalTags, parseTerms(settings.excludeAdditionalTags), settings.tagMatchMode)) return false;

    return true;
  }

  function filtersRequireDetailedMetadata(settings) {
    return settings.completion !== 'all'
      || parseNonNegativeNumber(settings.minWords) !== null
      || parseNonNegativeNumber(settings.maxWords) !== null
      || settings.ratings.length > 0
      || settings.categories.length > 0
      || parseTerms(settings.languages).length > 0
      || parseTerms(settings.fandoms).length > 0
      || parseTerms(settings.relationships).length > 0
      || parseTerms(settings.characters).length > 0
      || parseTerms(settings.additionalTags).length > 0
      || parseTerms(settings.excludeWarnings).length > 0
      || parseTerms(settings.excludeRelationships).length > 0
      || parseTerms(settings.excludeCharacters).length > 0
      || parseTerms(settings.excludeAdditionalTags).length > 0;
  }

  function workNeedsDetailedMetadata(work, settings) {
    if (parseTerms(settings.languages).length > 0 && !work.language) return true;
    return work.metadataSource === 'link' && filtersRequireDetailedMetadata(settings);
  }

  function needsDetailedMetadata(settings) {
    return parseTerms(settings.languages).length > 0 || filtersRequireDetailedMetadata(settings);
  }

  async function enrichWorksForFiltering(works, settings) {
    const targetCount = works.filter((work) => workNeedsDetailedMetadata(work, settings)).length;
    if (targetCount === 0) return works;

    if (parseTerms(settings.languages).length > 0) {
      log('语言不会显示在普通作品列表中，正在逐个读取作品页以完成语言筛选。', 'warn');
    } else {
      log('当前列表只有部分作品链接，正在读取作品页以补全筛选字段。', 'warn');
    }

    const enriched = [];
    let detailIndex = 0;

    for (let index = 0; index < works.length; index += 1) {
      await waitWhilePaused();
      if (runtime.stopped) throw new Error('任务已停止');

      const work = works[index];
      if (!workNeedsDetailedMetadata(work, settings)) {
        enriched.push(work);
        continue;
      }

      detailIndex += 1;
      setStatus(`补充筛选信息 ${detailIndex}/${targetCount}：${work.title}`);
      try {
        const loaded = await loadWorkDocument(work);
        const detailed = parseWorkPage(loaded.document, loaded.finalUrl);
        enriched.push(mergeWorkMetadata(work, detailed));
      } catch (error) {
        log(`无法读取作品 ${work.id} 的筛选信息：${error.message}`, 'error');
        enriched.push(work);
      }

      if (detailIndex < targetCount) {
        await interruptibleSleep(Math.max(0, settings.scanDelaySeconds) * 1000);
      }
    }
    return enriched;
  }

  async function scanAllPages(settings) {
    runtime.scanning = true;
    runtime.stopped = false;
    runtime.paused = false;
    runtime.works = [];
    runtime.filteredWorks = [];
    runtime.scannedPages = 0;
    runtime.currentIndex = 0;
    runtime.stats.success = 0;
    runtime.stats.failed = 0;
    runtime.stats.skipped = 0;
    setBusyState();
    updateStats();

    const startUrl = buildStartUrl();
    runtime.sourceUrl = startUrl;
    const worksById = new Map();
    const visitedPages = new Set();
    let pageUrl = startUrl;

    log(`开始扫描：${startUrl}`);

    try {
      while (pageUrl) {
        await waitWhilePaused();
        if (runtime.stopped) throw new Error('扫描已停止');
        if (visitedPages.has(pageUrl)) {
          log(`检测到重复分页链接，停止扫描：${pageUrl}`, 'warn');
          break;
        }
        if (visitedPages.size >= MAX_PAGE_SAFETY_LIMIT) {
          throw new Error(`分页数量超过安全上限 ${MAX_PAGE_SAFETY_LIMIT}`);
        }

        visitedPages.add(pageUrl);
        setStatus(`正在扫描第 ${visitedPages.size} 页`);
        const { document: doc, finalUrl } = await requestDocument(pageUrl, `第 ${visitedPages.size} 页`);
        runtime.scannedPages = visitedPages.size;

        const pageWorkId = extractWorkId(new URL(finalUrl).pathname);
        let pageWorks;
        if (pageWorkId) {
          const work = parseWorkPage(doc, finalUrl);
          pageWorks = work ? [work] : [];
        } else {
          pageWorks = parseWorksFromList(doc, finalUrl);
        }

        for (const work of pageWorks) {
          if (!worksById.has(work.id)) worksById.set(work.id, work);
        }

        runtime.works = [...worksById.values()];
        updateStats();
        log(`第 ${runtime.scannedPages} 页：发现 ${pageWorks.length} 条，累计去重后 ${runtime.works.length} 部作品。`);

        const nextUrl = pageWorkId ? null : getNextPageUrl(doc, finalUrl);
        if (!nextUrl) break;
        pageUrl = nextUrl;
        await interruptibleSleep(Math.max(0, settings.scanDelaySeconds) * 1000);
      }

      runtime.works = await enrichWorksForFiltering([...worksById.values()], settings);
      applyFilters(settings, false);
      GM_setValue(STORAGE_LAST_TASK, {
        sourceUrl: runtime.sourceUrl,
        scannedAt: new Date().toISOString(),
        workIds: runtime.works.map((work) => work.id),
      });

      if (runtime.works.length === 0) {
        setStatus('扫描完成，但当前页面没有识别到作品');
        log('没有识别到作品。请确认当前页面是作品列表、系列页、书签页或单篇作品页。', 'warn');
      } else {
        setStatus(`扫描完成：${runtime.works.length} 部，筛选后 ${runtime.filteredWorks.length} 部`);
        log(`扫描完成：共 ${runtime.scannedPages} 页，${runtime.works.length} 部作品，筛选后 ${runtime.filteredWorks.length} 部。`);
      }
    } finally {
      runtime.scanning = false;
      setBusyState();
      updateStats();
    }
  }

  function applyFilters(settings, announce = true) {
    runtime.filteredWorks = runtime.works.filter((work) => workMatchesFilters(work, settings));
    runtime.currentIndex = 0;
    updateStats();
    setBusyState();
    if (announce) {
      setStatus(`筛选完成：${runtime.filteredWorks.length}/${runtime.works.length}`);
      log(`重新应用筛选：保留 ${runtime.filteredWorks.length}/${runtime.works.length} 部作品。`);
    }
  }

  function getSelectedFormats(settings) {
    return ['EPUB', 'PDF'].filter((format) => settings.formats.includes(format));
  }

  function formatRecordIsSuccessful(records, workId, format) {
    return records?.[workId]?.formats?.[format]?.status === 'success';
  }

  function updateDownloadRecord(records, work, format, status, extra = {}) {
    if (!records[work.id]) {
      records[work.id] = {
        id: work.id,
        title: work.title,
        url: work.url,
        formats: {},
      };
    }

    records[work.id].title = work.title;
    records[work.id].url = work.url;
    records[work.id].formats[format] = {
      status,
      updatedAt: new Date().toISOString(),
      ...extra,
    };
    saveRecords(records);
  }

  function filenameFromDownloadUrl(url, format, workId) {
    try {
      const parsed = new URL(url);
      const rawName = parsed.pathname.split('/').filter(Boolean).pop() || '';
      const decoded = decodeURIComponent(rawName).replace(/[\\/:*?"<>|]/g, '').trim();
      if (decoded && decoded.toLocaleLowerCase().endsWith(`.${format.toLocaleLowerCase()}`)) return decoded;
    } catch {
      // 使用回退文件名。
    }
    return `${workId}.${format.toLocaleLowerCase()}`;
  }

  function gmDownloadFile(url, filename) {
    return new Promise((resolve, reject) => {
      let handle;
      try {
        handle = GM_download({
          url,
          name: filename,
          saveAs: false,
          conflictAction: 'uniquify',
          onload: () => {
            runtime.activeDownloads.delete(handle);
            resolve();
          },
          onerror: (error) => {
            runtime.activeDownloads.delete(handle);
            const reason = error?.error || 'not_succeeded';
            const details = error?.details ? `：${error.details}` : '';
            reject(new Error(`下载失败 ${reason}${details}`));
          },
          ontimeout: () => {
            runtime.activeDownloads.delete(handle);
            reject(new Error('下载超时'));
          },
        });
        if (handle) runtime.activeDownloads.add(handle);
      } catch (error) {
        runtime.activeDownloads.delete(handle);
        reject(error);
      }
    });
  }

  function abortActiveDownloads() {
    for (const handle of runtime.activeDownloads) {
      try {
        handle?.abort?.();
      } catch {
        // 忽略取消失败。
      }
    }
    runtime.activeDownloads.clear();
  }

  async function downloadWorks(settings) {
    const formats = getSelectedFormats(settings);
    if (!formats.length) throw new Error('至少选择 EPUB 或 PDF 一种格式');
    if (!runtime.filteredWorks.length) throw new Error('筛选结果为空，请先扫描或修改筛选条件');

    runtime.running = true;
    runtime.stopped = false;
    runtime.paused = false;
    runtime.currentIndex = 0;
    runtime.stats.success = 0;
    runtime.stats.failed = 0;
    runtime.stats.skipped = 0;
    setBusyState();
    updateStats();

    const records = loadRecords();
    log(`开始下载 ${runtime.filteredWorks.length} 部作品，格式：${formats.join('、')}。`);

    try {
      for (let index = 0; index < runtime.filteredWorks.length; index += 1) {
        await waitWhilePaused();
        if (runtime.stopped) throw new Error('下载任务已停止');

        const work = runtime.filteredWorks[index];
        runtime.currentIndex = index;
        updateStats();
        setStatus(`读取作品 ${index + 1}/${runtime.filteredWorks.length}：${work.title}`);

        const pendingFormats = formats.filter((format) => {
          const alreadyDownloaded = formatRecordIsSuccessful(records, work.id, format);
          if (settings.skipDownloaded && alreadyDownloaded) {
            runtime.stats.skipped += 1;
            log(`跳过已下载：${work.title} [${format}]`);
            return false;
          }
          return true;
        });

        if (!pendingFormats.length) {
          runtime.currentIndex = index + 1;
          updateStats();
          continue;
        }

        let loaded;
        try {
          loaded = await loadWorkDocument(work);
        } catch (error) {
          for (const format of pendingFormats) {
            runtime.stats.failed += 1;
            updateDownloadRecord(records, work, format, 'failed', { error: error.message });
          }
          log(`无法读取作品：${work.title}（${error.message}）`, 'error');
          runtime.currentIndex = index + 1;
          updateStats();
          if (index < runtime.filteredWorks.length - 1) {
            await interruptibleSleep(Math.max(0, settings.workDelaySeconds) * 1000);
          }
          continue;
        }

        const downloadLinks = getDownloadLinks(loaded.document, loaded.finalUrl);

        for (let formatIndex = 0; formatIndex < pendingFormats.length; formatIndex += 1) {
          await waitWhilePaused();
          if (runtime.stopped) throw new Error('下载任务已停止');

          const format = pendingFormats[formatIndex];
          const downloadUrl = downloadLinks[format];
          if (!downloadUrl) {
            const message = `作品页没有找到 ${format} 下载链接`;
            runtime.stats.failed += 1;
            updateDownloadRecord(records, work, format, 'failed', { error: message });
            log(`${work.title} [${format}]：${message}`, 'error');
            continue;
          }

          const filename = filenameFromDownloadUrl(downloadUrl, format, work.id);
          setStatus(`下载 ${index + 1}/${runtime.filteredWorks.length}：${filename}`);
          log(`开始下载：${filename}`);

          try {
            await gmDownloadFile(downloadUrl, filename);
            runtime.stats.success += 1;
            updateDownloadRecord(records, work, format, 'success', { filename, downloadUrl });
            log(`下载完成：${filename}`, 'success');
          } catch (error) {
            runtime.stats.failed += 1;
            updateDownloadRecord(records, work, format, 'failed', {
              filename,
              downloadUrl,
              error: error.message,
            });
            log(`${filename}：${error.message}`, 'error');
          }

          updateStats();
          if (formatIndex < pendingFormats.length - 1) {
            await interruptibleSleep(Math.max(0, settings.formatDelaySeconds) * 1000);
          }
        }

        runtime.currentIndex = index + 1;
        updateStats();

        if (index < runtime.filteredWorks.length - 1) {
          await interruptibleSleep(Math.max(0, settings.workDelaySeconds) * 1000);
        }
      }

      setStatus(`下载结束：成功 ${runtime.stats.success}，失败 ${runtime.stats.failed}，跳过 ${runtime.stats.skipped}`);
      log(`任务结束：成功 ${runtime.stats.success}，失败 ${runtime.stats.failed}，跳过 ${runtime.stats.skipped}。`);
    } finally {
      runtime.running = false;
      runtime.paused = false;
      abortActiveDownloads();
      setBusyState();
      updateStats();
    }
  }

  function timestampForFilename() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  function saveTextFile(filename, content, type = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function exportLinks(works, suffix) {
    const links = unique(works.map((work) => canonicalWorkUrl(work.id)));
    if (!links.length) {
      log('没有可导出的作品链接。', 'warn');
      return;
    }
    const filename = `ao3-${suffix}-links-${timestampForFilename()}.txt`;
    saveTextFile(filename, `${links.join('\n')}\n`);
    log(`已导出 ${links.length} 条作品链接：${filename}`, 'success');
  }

  function exportRecords() {
    const records = loadRecords();
    const filename = `ao3-download-records-${timestampForFilename()}.json`;
    saveTextFile(filename, `${JSON.stringify(records, null, 2)}\n`, 'application/json;charset=utf-8');
    log(`已导出下载记录：${filename}`, 'success');
  }

  function collectCheckedValues(selector) {
    return [...document.querySelectorAll(selector)]
      .filter((input) => input.checked)
      .map((input) => input.value);
  }

  function collectSettingsFromUi() {
    const settings = {
      formats: collectCheckedValues('[data-ao3bd-format]'),
      skipDownloaded: ui.skipDownloaded.checked,
      scanDelaySeconds: Math.max(0, Number(ui.scanDelay.value) || 0),
      workDelaySeconds: Math.max(0, Number(ui.workDelay.value) || 0),
      formatDelaySeconds: Math.max(0, Number(ui.formatDelay.value) || 0),
      completion: ui.completion.value,
      minWords: ui.minWords.value.trim(),
      maxWords: ui.maxWords.value.trim(),
      ratings: collectCheckedValues('[data-ao3bd-rating]'),
      categories: collectCheckedValues('[data-ao3bd-category]'),
      languages: ui.languages.value,
      fandoms: ui.fandoms.value,
      relationships: ui.relationships.value,
      characters: ui.characters.value,
      additionalTags: ui.additionalTags.value,
      excludeWarnings: ui.excludeWarnings.value,
      excludeRelationships: ui.excludeRelationships.value,
      excludeCharacters: ui.excludeCharacters.value,
      excludeAdditionalTags: ui.excludeAdditionalTags.value,
      includeMode: ui.includeMode.value,
      tagMatchMode: ui.tagMatchMode.value,
    };
    saveSettings(settings);
    return settings;
  }

  function populateUi(settings) {
    for (const input of document.querySelectorAll('[data-ao3bd-format]')) {
      input.checked = settings.formats.includes(input.value);
    }
    for (const input of document.querySelectorAll('[data-ao3bd-rating]')) {
      input.checked = settings.ratings.includes(input.value);
    }
    for (const input of document.querySelectorAll('[data-ao3bd-category]')) {
      input.checked = settings.categories.includes(input.value);
    }

    ui.skipDownloaded.checked = settings.skipDownloaded;
    ui.scanDelay.value = settings.scanDelaySeconds;
    ui.workDelay.value = settings.workDelaySeconds;
    ui.formatDelay.value = settings.formatDelaySeconds;
    ui.completion.value = settings.completion;
    ui.minWords.value = settings.minWords;
    ui.maxWords.value = settings.maxWords;
    ui.languages.value = settings.languages;
    ui.fandoms.value = settings.fandoms;
    ui.relationships.value = settings.relationships;
    ui.characters.value = settings.characters;
    ui.additionalTags.value = settings.additionalTags;
    ui.excludeWarnings.value = settings.excludeWarnings;
    ui.excludeRelationships.value = settings.excludeRelationships;
    ui.excludeCharacters.value = settings.excludeCharacters;
    ui.excludeAdditionalTags.value = settings.excludeAdditionalTags;
    ui.includeMode.value = settings.includeMode;
    ui.tagMatchMode.value = settings.tagMatchMode;
  }

  function checkboxMarkup(attribute, values) {
    return values.map((value) => `
      <label class="ao3bd-check">
        <input type="checkbox" ${attribute} value="${value}">
        <span>${value}</span>
      </label>`).join('');
  }

  function createUi() {
    GM_addStyle(`
      #ao3bd-launcher {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483645;
        border: 1px solid #6f0000;
        border-radius: 999px;
        padding: 10px 16px;
        background: #990000;
        color: #fff;
        font: 600 14px/1.2 Arial, sans-serif;
        box-shadow: 0 4px 18px rgba(0, 0, 0, .28);
        cursor: pointer;
      }
      #ao3bd-launcher:hover { background: #760000; }
      #ao3bd-panel {
        position: fixed;
        top: 4vh;
        right: 18px;
        z-index: 2147483646;
        display: none;
        width: min(560px, calc(100vw - 36px));
        max-height: 92vh;
        overflow: auto;
        box-sizing: border-box;
        border: 1px solid #777;
        border-radius: 10px;
        background: #fff;
        color: #222;
        box-shadow: 0 12px 40px rgba(0, 0, 0, .35);
        font: 14px/1.45 Arial, "Microsoft YaHei", sans-serif;
      }
      #ao3bd-panel.ao3bd-open { display: block; }
      #ao3bd-panel * { box-sizing: border-box; }
      .ao3bd-header {
        position: sticky;
        top: 0;
        z-index: 2;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        background: #7d0000;
        color: #fff;
      }
      .ao3bd-title { margin: 0; font-size: 17px; }
      .ao3bd-close {
        border: 0;
        background: transparent;
        color: #fff;
        font-size: 24px;
        line-height: 1;
        cursor: pointer;
      }
      .ao3bd-body { padding: 12px; }
      .ao3bd-notice {
        margin: 0 0 10px;
        padding: 9px 10px;
        border-left: 4px solid #990000;
        background: #f4eeee;
      }
      .ao3bd-section {
        margin: 10px 0;
        border: 1px solid #ccc;
        border-radius: 6px;
        background: #fafafa;
      }
      .ao3bd-section > summary {
        padding: 9px 10px;
        font-weight: 700;
        cursor: pointer;
      }
      .ao3bd-section-content { padding: 0 10px 10px; }
      .ao3bd-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px 10px;
      }
      .ao3bd-field { display: flex; flex-direction: column; gap: 4px; }
      .ao3bd-field-wide { grid-column: 1 / -1; }
      .ao3bd-field label, .ao3bd-label { font-weight: 600; }
      .ao3bd-field input[type="number"],
      .ao3bd-field input[type="text"],
      .ao3bd-field select,
      .ao3bd-field textarea {
        width: 100%;
        min-height: 34px;
        border: 1px solid #aaa;
        border-radius: 4px;
        padding: 6px 7px;
        background: #fff;
        color: #222;
        font: inherit;
      }
      .ao3bd-field textarea { min-height: 62px; resize: vertical; }
      .ao3bd-checks { display: flex; flex-wrap: wrap; gap: 7px 12px; }
      .ao3bd-check { display: inline-flex; align-items: center; gap: 5px; }
      .ao3bd-help { margin: 4px 0 0; color: #555; font-size: 12px; }
      .ao3bd-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
      .ao3bd-button {
        min-height: 34px;
        border: 1px solid #777;
        border-radius: 5px;
        padding: 6px 10px;
        background: #eee;
        color: #222;
        font: 600 13px/1.2 inherit;
        cursor: pointer;
      }
      .ao3bd-button:hover:not(:disabled) { background: #ddd; }
      .ao3bd-button:disabled { opacity: .45; cursor: not-allowed; }
      .ao3bd-primary { border-color: #720000; background: #990000; color: #fff; }
      .ao3bd-primary:hover:not(:disabled) { background: #760000; }
      .ao3bd-danger { border-color: #8c1d1d; color: #8c1d1d; }
      .ao3bd-status {
        min-height: 38px;
        margin: 8px 0;
        padding: 8px 10px;
        border-radius: 5px;
        background: #eee;
      }
      .ao3bd-stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
        margin: 8px 0;
      }
      .ao3bd-stat { padding: 7px; border: 1px solid #ddd; background: #fff; text-align: center; }
      .ao3bd-stat strong { display: block; font-size: 17px; }
      .ao3bd-progress { height: 10px; overflow: hidden; border-radius: 999px; background: #ddd; }
      .ao3bd-progress > div { width: 0; height: 100%; background: #990000; transition: width .15s; }
      .ao3bd-progress-row { display: flex; justify-content: space-between; margin: 5px 0; }
      .ao3bd-log {
        height: 190px;
        overflow: auto;
        border: 1px solid #bbb;
        border-radius: 4px;
        padding: 7px;
        background: #151515;
        color: #e8e8e8;
        font: 12px/1.5 Consolas, monospace;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .ao3bd-log-line { margin-bottom: 2px; }
      .ao3bd-log-warn { color: #ffd479; }
      .ao3bd-log-error { color: #ff8c8c; }
      .ao3bd-log-success { color: #94e394; }
      .ao3bd-footer { margin-top: 10px; color: #666; font-size: 12px; }
      @media (max-width: 620px) {
        #ao3bd-panel { right: 8px; width: calc(100vw - 16px); }
        #ao3bd-launcher { right: 10px; bottom: 10px; }
        .ao3bd-grid { grid-template-columns: 1fr; }
        .ao3bd-field-wide { grid-column: auto; }
      }
    `);

    const launcher = document.createElement('button');
    launcher.id = 'ao3bd-launcher';
    launcher.type = 'button';
    launcher.textContent = 'AO3 批量下载';
    document.body.appendChild(launcher);

    const panel = document.createElement('section');
    panel.id = 'ao3bd-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', APP_NAME);
    panel.innerHTML = `
      <header class="ao3bd-header">
        <h2 class="ao3bd-title">${APP_NAME} <small>v${APP_VERSION}</small></h2>
        <button type="button" class="ao3bd-close" aria-label="关闭">×</button>
      </header>
      <div class="ao3bd-body">
        <p class="ao3bd-notice">脚本会读取当前 AO3 筛选结果的全部分页，再从每部作品页提取 AO3 官方 EPUB 和 PDF 下载链接。不会把列表页面保存成文件。</p>

        <details class="ao3bd-section" open>
          <summary>下载格式与请求间隔</summary>
          <div class="ao3bd-section-content ao3bd-grid">
            <div class="ao3bd-field ao3bd-field-wide">
              <span class="ao3bd-label">下载格式</span>
              <div class="ao3bd-checks">
                <label class="ao3bd-check"><input type="checkbox" data-ao3bd-format value="EPUB"><span>EPUB</span></label>
                <label class="ao3bd-check"><input type="checkbox" data-ao3bd-format value="PDF"><span>PDF</span></label>
                <label class="ao3bd-check"><input type="checkbox" id="ao3bd-skip-downloaded"><span>跳过已有成功记录</span></label>
              </div>
            </div>
            <div class="ao3bd-field">
              <label for="ao3bd-scan-delay">分页/筛选请求间隔（秒）</label>
              <input id="ao3bd-scan-delay" type="number" min="0" max="60" step="0.5">
            </div>
            <div class="ao3bd-field">
              <label for="ao3bd-work-delay">作品之间间隔（秒）</label>
              <input id="ao3bd-work-delay" type="number" min="0" max="60" step="0.5">
            </div>
            <div class="ao3bd-field">
              <label for="ao3bd-format-delay">同一作品两种格式间隔（秒）</label>
              <input id="ao3bd-format-delay" type="number" min="0" max="60" step="0.5">
            </div>
          </div>
        </details>

        <details class="ao3bd-section">
          <summary>基础筛选</summary>
          <div class="ao3bd-section-content ao3bd-grid">
            <div class="ao3bd-field">
              <label for="ao3bd-completion">完结状态</label>
              <select id="ao3bd-completion">
                <option value="all">全部</option>
                <option value="complete">仅完结</option>
                <option value="incomplete">仅未完结</option>
              </select>
            </div>
            <div class="ao3bd-field">
              <label for="ao3bd-min-words">最低字数</label>
              <input id="ao3bd-min-words" type="number" min="0" step="1" placeholder="不限制">
            </div>
            <div class="ao3bd-field">
              <label for="ao3bd-max-words">最高字数</label>
              <input id="ao3bd-max-words" type="number" min="0" step="1" placeholder="不限制">
            </div>
            <div class="ao3bd-field ao3bd-field-wide">
              <span class="ao3bd-label">分级（不勾选表示全部）</span>
              <div class="ao3bd-checks">${checkboxMarkup('data-ao3bd-rating', RATING_OPTIONS)}</div>
            </div>
            <div class="ao3bd-field ao3bd-field-wide">
              <span class="ao3bd-label">分类（不勾选表示全部）</span>
              <div class="ao3bd-checks">${checkboxMarkup('data-ao3bd-category', CATEGORY_OPTIONS)}</div>
            </div>
          </div>
        </details>

        <details class="ao3bd-section">
          <summary>标签与语言筛选</summary>
          <div class="ao3bd-section-content ao3bd-grid">
            <div class="ao3bd-field">
              <label for="ao3bd-include-mode">多个包含条件</label>
              <select id="ao3bd-include-mode">
                <option value="any">命中任意一项</option>
                <option value="all">必须全部命中</option>
              </select>
            </div>
            <div class="ao3bd-field">
              <label for="ao3bd-tag-match-mode">标签匹配方式</label>
              <select id="ao3bd-tag-match-mode">
                <option value="exact">完整标签相同</option>
                <option value="contains">标签中包含文字</option>
              </select>
            </div>
            <div class="ao3bd-field ao3bd-field-wide">
              <label for="ao3bd-languages">语言</label>
              <textarea id="ao3bd-languages" placeholder="每行一个，例如：\nEnglish\n中文-普通话 國語"></textarea>
              <p class="ao3bd-help">使用语言筛选时，脚本需要额外读取每部作品页。</p>
            </div>
            <div class="ao3bd-field">
              <label for="ao3bd-fandoms">包含 Fandom</label>
              <textarea id="ao3bd-fandoms" placeholder="每行一个"></textarea>
            </div>
            <div class="ao3bd-field">
              <label for="ao3bd-relationships">包含 Relationship</label>
              <textarea id="ao3bd-relationships" placeholder="每行一个"></textarea>
            </div>
            <div class="ao3bd-field">
              <label for="ao3bd-characters">包含 Character</label>
              <textarea id="ao3bd-characters" placeholder="每行一个"></textarea>
            </div>
            <div class="ao3bd-field">
              <label for="ao3bd-additional-tags">包含 Additional Tag</label>
              <textarea id="ao3bd-additional-tags" placeholder="每行一个"></textarea>
            </div>
            <div class="ao3bd-field">
              <label for="ao3bd-exclude-warnings">排除 Warning</label>
              <textarea id="ao3bd-exclude-warnings" placeholder="命中任意一行就排除"></textarea>
            </div>
            <div class="ao3bd-field">
              <label for="ao3bd-exclude-relationships">排除 Relationship</label>
              <textarea id="ao3bd-exclude-relationships" placeholder="命中任意一行就排除"></textarea>
            </div>
            <div class="ao3bd-field">
              <label for="ao3bd-exclude-characters">排除 Character</label>
              <textarea id="ao3bd-exclude-characters" placeholder="命中任意一行就排除"></textarea>
            </div>
            <div class="ao3bd-field">
              <label for="ao3bd-exclude-additional-tags">排除 Additional Tag</label>
              <textarea id="ao3bd-exclude-additional-tags" placeholder="命中任意一行就排除"></textarea>
            </div>
          </div>
        </details>

        <div class="ao3bd-actions">
          <button type="button" class="ao3bd-button ao3bd-primary" id="ao3bd-scan">扫描全部分页</button>
          <button type="button" class="ao3bd-button" id="ao3bd-apply-filter">重新应用筛选</button>
          <button type="button" class="ao3bd-button ao3bd-primary" id="ao3bd-start">开始下载</button>
          <button type="button" class="ao3bd-button" id="ao3bd-pause">暂停</button>
          <button type="button" class="ao3bd-button ao3bd-danger" id="ao3bd-stop">停止</button>
        </div>

        <div class="ao3bd-status" id="ao3bd-status">等待操作</div>
        <div class="ao3bd-progress-row"><span>进度</span><span id="ao3bd-progress-text">0 / 0</span></div>
        <div class="ao3bd-progress"><div id="ao3bd-progress-bar"></div></div>

        <div class="ao3bd-stats">
          <div class="ao3bd-stat"><strong id="ao3bd-stat-pages">0</strong>页</div>
          <div class="ao3bd-stat"><strong id="ao3bd-stat-discovered">0</strong>发现</div>
          <div class="ao3bd-stat"><strong id="ao3bd-stat-filtered">0</strong>筛选后</div>
          <div class="ao3bd-stat"><strong id="ao3bd-stat-success">0</strong>成功</div>
          <div class="ao3bd-stat"><strong id="ao3bd-stat-failed">0</strong>失败</div>
          <div class="ao3bd-stat"><strong id="ao3bd-stat-skipped">0</strong>跳过</div>
        </div>

        <div class="ao3bd-actions">
          <button type="button" class="ao3bd-button" id="ao3bd-export-filtered">导出筛选后链接 TXT</button>
          <button type="button" class="ao3bd-button" id="ao3bd-export-all">导出全部链接 TXT</button>
          <button type="button" class="ao3bd-button" id="ao3bd-export-records">导出下载记录 JSON</button>
          <button type="button" class="ao3bd-button ao3bd-danger" id="ao3bd-clear-records">清空下载记录</button>
        </div>

        <div class="ao3bd-log" id="ao3bd-log" aria-live="polite"></div>
        <p class="ao3bd-footer">文件名沿用 AO3 下载链接中的官方文件名。首次批量下载时，Chrome 或 Tampermonkey 可能要求允许下载权限。</p>
      </div>`;
    document.body.appendChild(panel);

    Object.assign(ui, {
      launcher,
      panel,
      closeButton: panel.querySelector('.ao3bd-close'),
      scanButton: panel.querySelector('#ao3bd-scan'),
      applyFilterButton: panel.querySelector('#ao3bd-apply-filter'),
      startButton: panel.querySelector('#ao3bd-start'),
      pauseButton: panel.querySelector('#ao3bd-pause'),
      stopButton: panel.querySelector('#ao3bd-stop'),
      exportFilteredButton: panel.querySelector('#ao3bd-export-filtered'),
      exportAllButton: panel.querySelector('#ao3bd-export-all'),
      exportRecordsButton: panel.querySelector('#ao3bd-export-records'),
      clearRecordsButton: panel.querySelector('#ao3bd-clear-records'),
      skipDownloaded: panel.querySelector('#ao3bd-skip-downloaded'),
      scanDelay: panel.querySelector('#ao3bd-scan-delay'),
      workDelay: panel.querySelector('#ao3bd-work-delay'),
      formatDelay: panel.querySelector('#ao3bd-format-delay'),
      completion: panel.querySelector('#ao3bd-completion'),
      minWords: panel.querySelector('#ao3bd-min-words'),
      maxWords: panel.querySelector('#ao3bd-max-words'),
      languages: panel.querySelector('#ao3bd-languages'),
      fandoms: panel.querySelector('#ao3bd-fandoms'),
      relationships: panel.querySelector('#ao3bd-relationships'),
      characters: panel.querySelector('#ao3bd-characters'),
      additionalTags: panel.querySelector('#ao3bd-additional-tags'),
      excludeWarnings: panel.querySelector('#ao3bd-exclude-warnings'),
      excludeRelationships: panel.querySelector('#ao3bd-exclude-relationships'),
      excludeCharacters: panel.querySelector('#ao3bd-exclude-characters'),
      excludeAdditionalTags: panel.querySelector('#ao3bd-exclude-additional-tags'),
      includeMode: panel.querySelector('#ao3bd-include-mode'),
      tagMatchMode: panel.querySelector('#ao3bd-tag-match-mode'),
      status: panel.querySelector('#ao3bd-status'),
      progressText: panel.querySelector('#ao3bd-progress-text'),
      progressBar: panel.querySelector('#ao3bd-progress-bar'),
      statPages: panel.querySelector('#ao3bd-stat-pages'),
      statDiscovered: panel.querySelector('#ao3bd-stat-discovered'),
      statFiltered: panel.querySelector('#ao3bd-stat-filtered'),
      statSuccess: panel.querySelector('#ao3bd-stat-success'),
      statFailed: panel.querySelector('#ao3bd-stat-failed'),
      statSkipped: panel.querySelector('#ao3bd-stat-skipped'),
      log: panel.querySelector('#ao3bd-log'),
    });

    const togglePanel = (open = !runtime.panelOpen) => {
      runtime.panelOpen = Boolean(open);
      ui.panel.classList.toggle('ao3bd-open', runtime.panelOpen);
      if (runtime.panelOpen) ui.scanButton.focus();
    };

    ui.launcher.addEventListener('click', () => togglePanel());
    ui.closeButton.addEventListener('click', () => togglePanel(false));

    ui.scanButton.addEventListener('click', async () => {
      const settings = collectSettingsFromUi();
      try {
        await scanAllPages(settings);
      } catch (error) {
        setStatus(error.message);
        log(error.message, runtime.stopped ? 'warn' : 'error');
        runtime.scanning = false;
        setBusyState();
      }
    });

    ui.applyFilterButton.addEventListener('click', () => {
      const settings = collectSettingsFromUi();
      if (needsDetailedMetadata(settings) && runtime.works.some((work) => workNeedsDetailedMetadata(work, settings))) {
        log('当前筛选需要更完整的作品信息。为保证结果准确，请重新执行“扫描全部分页”。', 'warn');
      }
      applyFilters(settings);
    });

    ui.startButton.addEventListener('click', async () => {
      const settings = collectSettingsFromUi();
      try {
        await downloadWorks(settings);
      } catch (error) {
        setStatus(error.message);
        log(error.message, runtime.stopped ? 'warn' : 'error');
        runtime.running = false;
        runtime.paused = false;
        setBusyState();
      }
    });

    ui.pauseButton.addEventListener('click', () => {
      if (!runtime.running) return;
      runtime.paused = !runtime.paused;
      setStatus(runtime.paused ? '任务已暂停，当前正在进行的文件会先完成' : '任务继续');
      log(runtime.paused ? '任务已暂停。' : '任务继续。', 'warn');
      setBusyState();
    });

    ui.stopButton.addEventListener('click', () => {
      runtime.stopped = true;
      runtime.paused = false;
      abortActiveDownloads();
      setStatus('正在停止任务');
      log('收到停止指令。', 'warn');
    });

    ui.exportFilteredButton.addEventListener('click', () => exportLinks(runtime.filteredWorks, 'filtered'));
    ui.exportAllButton.addEventListener('click', () => exportLinks(runtime.works, 'all'));
    ui.exportRecordsButton.addEventListener('click', exportRecords);
    ui.clearRecordsButton.addEventListener('click', () => {
      if (!window.confirm('确定清空全部下载记录吗？这不会删除电脑里的文件。')) return;
      GM_deleteValue(STORAGE_RECORDS);
      log('下载记录已清空。', 'warn');
    });

    for (const element of panel.querySelectorAll('input, select, textarea')) {
      element.addEventListener('change', () => {
        try {
          collectSettingsFromUi();
        } catch {
          // 输入尚未完成时不提示。
        }
      });
    }

    populateUi(loadSettings());
    updateStats();
    setBusyState();
    log(`${APP_NAME} v${APP_VERSION} 已加载。`);

    GM_registerMenuCommand('打开 AO3 批量下载面板', () => togglePanel(true));
  }

  if (globalThis.__AO3BD_TEST_MODE__) {
    globalThis.__AO3BD_TEST_API__ = {
      extractWorkId,
      parseTerms,
      parseNonNegativeNumber,
      parseChapterStats,
      normalizeRating,
      normalizeCategories,
      workMatchesFilters,
      filenameFromDownloadUrl,
      parseWorksFromList,
      parseWorkPage,
      getDownloadLinks,
    };
  } else if (document.body) {
    createUi();
  } else {
    window.addEventListener('DOMContentLoaded', createUi, { once: true });
  }
})();
