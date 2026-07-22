// ==UserScript==
// @name         AO3 TXT 批量作品下载器
// @namespace    https://github.com/zoeapo/ao3-batch-downloader-userscript
// @version      0.2.0
// @description  导入包含 AO3 作品网址的 TXT 文件，自动清洗、去重，并批量下载官方 EPUB 和 PDF。
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
// @grant        GM_xmlhttpRequest
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
 * 面向浏览器的独立重写，功能设计参考：
 * https://github.com/nianeyna/ao3downloader
 *
 * 本项目与 Archive of Our Own、OTW 以及原 ao3downloader 作者无隶属关系。
 */

(() => {
  'use strict';

  const APP_NAME = 'AO3 TXT 批量作品下载器';
  const APP_VERSION = '0.2.0';
  const CANONICAL_ORIGIN = 'https://archiveofourown.org';
  const STORAGE_SETTINGS = 'ao3txt.settings.v2';
  const STORAGE_RECORDS = 'ao3txt.records.v2';
  const STORAGE_QUEUE = 'ao3txt.queue.v2';
  const STORAGE_INVALID = 'ao3txt.invalid.v2';

  const DEFAULT_SETTINGS = Object.freeze({
    formats: ['EPUB', 'PDF'],
    skipDownloaded: true,
    workDelaySeconds: 3,
    formatDelaySeconds: 1,
    maxRetries: 2,
    requestTimeoutSeconds: 60,
  });

  const RETRY_STATUS = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

  const runtime = {
    works: [],
    invalidLines: [],
    sourceName: '',
    totalNonEmptyLines: 0,
    duplicateCount: 0,
    running: false,
    paused: false,
    stopped: false,
    currentIndex: 0,
    activeDownloads: new Set(),
    stats: { success: 0, failed: 0, skipped: 0 },
  };

  const ui = {};

  function loadJson(key, fallback) {
    try {
      const value = GM_getValue(key, '');
      if (!value) return fallback;
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function saveJson(key, value) {
    GM_setValue(key, JSON.stringify(value));
  }

  function loadSettings() {
    return { ...DEFAULT_SETTINGS, ...loadJson(STORAGE_SETTINGS, {}) };
  }

  function saveSettings(settings) {
    saveJson(STORAGE_SETTINGS, settings);
  }

  function loadRecords() {
    return loadJson(STORAGE_RECORDS, {});
  }

  function saveRecords(records) {
    saveJson(STORAGE_RECORDS, records);
  }

  function restoreQueue() {
    const saved = loadJson(STORAGE_QUEUE, null);
    if (!saved || !Array.isArray(saved.works)) return;
    runtime.works = saved.works.filter((item) => item && /^\d+$/.test(String(item.id)));
    runtime.sourceName = saved.sourceName || '上次导入的 TXT';
    runtime.totalNonEmptyLines = Number(saved.totalNonEmptyLines) || runtime.works.length;
    runtime.duplicateCount = Number(saved.duplicateCount) || 0;
    runtime.invalidLines = loadJson(STORAGE_INVALID, []);
  }

  function persistQueue() {
    saveJson(STORAGE_QUEUE, {
      works: runtime.works,
      sourceName: runtime.sourceName,
      totalNonEmptyLines: runtime.totalNonEmptyLines,
      duplicateCount: runtime.duplicateCount,
      savedAt: new Date().toISOString(),
    });
    saveJson(STORAGE_INVALID, runtime.invalidLines);
  }

  function canonicalWorkUrl(id) {
    return `${CANONICAL_ORIGIN}/works/${id}`;
  }

  function extractWorkIds(text) {
    const matches = [];
    const absoluteRegex = /https?:\/\/(?:www\.)?(?:archiveofourown\.org|archiveofourown\.com|archiveofourown\.net|archiveofourown\.gay|ao3\.org|archive\.transformativeworks\.org)\/works\/(\d+)/gi;
    const relativeRegex = /(?:^|[\s"'(])\/works\/(\d+)/gi;
    let match;
    while ((match = absoluteRegex.exec(text)) !== null) matches.push(match[1]);
    while ((match = relativeRegex.exec(text)) !== null) matches.push(match[1]);
    return matches;
  }

  function parseTxt(text) {
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
    const seen = new Set();
    const works = [];
    const invalidLines = [];
    let totalNonEmptyLines = 0;
    let duplicateCount = 0;

    lines.forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line) return;
      totalNonEmptyLines += 1;

      const ids = extractWorkIds(line);
      if (!ids.length) {
        invalidLines.push({ lineNumber: index + 1, text: line });
        return;
      }

      ids.forEach((id) => {
        if (seen.has(id)) {
          duplicateCount += 1;
          return;
        }
        seen.add(id);
        works.push({ id, url: canonicalWorkUrl(id) });
      });
    });

    return { works, invalidLines, totalNonEmptyLines, duplicateCount };
  }

  function sanitizeFilename(name) {
    const cleaned = String(name)
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/[. ]+$/g, '')
      .trim();
    return cleaned || 'ao3-download';
  }

  function filenameFromDownloadUrl(url, format, workId) {
    try {
      const parsed = new URL(url);
      const raw = parsed.pathname.split('/').filter(Boolean).pop() || '';
      const decoded = sanitizeFilename(decodeURIComponent(raw));
      if (decoded.toLowerCase().endsWith(`.${format.toLowerCase()}`)) return decoded;
    } catch {
      // 使用回退文件名。
    }
    return `${workId}.${format.toLowerCase()}`;
  }

  function getSelectedFormats(settings) {
    return ['EPUB', 'PDF'].filter((format) => settings.formats.includes(format));
  }

  function parseHeaders(rawHeaders) {
    const result = {};
    String(rawHeaders || '').split(/\r?\n/).forEach((line) => {
      const index = line.indexOf(':');
      if (index <= 0) return;
      result[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    });
    return result;
  }

  function gmRequestText(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: timeoutMs,
        anonymous: false,
        headers: { Accept: 'text/html,application/xhtml+xml' },
        onload: (response) => {
          resolve({
            status: response.status,
            text: response.responseText || '',
            finalUrl: response.finalUrl || url,
            headers: parseHeaders(response.responseHeaders),
          });
        },
        onerror: (error) => reject(new Error(error?.error || '网络请求失败')),
        ontimeout: () => reject(new Error('读取作品页超时')),
      });
    });
  }

  function looksLikeCloudflare(html) {
    const source = String(html).toLowerCase();
    return [
      '<title>just a moment...</title>',
      '<title>attention required!</title>',
      'cf-browser-verification',
      'id="challenge-error-text"',
      '_cf_chl_opt',
    ].some((marker) => source.includes(marker));
  }

  function retryAfterSeconds(headers) {
    const raw = headers['retry-after'];
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return Math.ceil(numeric);
    if (raw) {
      const date = Date.parse(raw);
      if (Number.isFinite(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000));
    }
    return 300;
  }

  function parseWorkDocument(html, finalUrl) {
    const documentNode = new DOMParser().parseFromString(html, 'text/html');

    if (/\/users\/login(?:\?|$)/.test(finalUrl) || documentNode.querySelector('form#new_user')) {
      throw new Error('作品需要登录。请先在当前浏览器登录 AO3');
    }

    if (documentNode.querySelector('#main.error-404')) {
      throw new Error('作品不存在或已经删除');
    }

    const title = documentNode.querySelector('.preface .title')?.textContent?.trim()
      || documentNode.querySelector('h2.title')?.textContent?.trim()
      || `作品 ${finalUrl.match(/\/works\/(\d+)/)?.[1] || ''}`;

    const links = {};
    documentNode.querySelectorAll('li.download a').forEach((anchor) => {
      const label = anchor.textContent.trim().toUpperCase();
      if (label === 'EPUB' || label === 'PDF') {
        links[label] = new URL(anchor.getAttribute('href'), finalUrl).href;
      }
    });

    if (!links.EPUB && !links.PDF) {
      const notice = documentNode.querySelector('.flash.error, .notice, p.caution')?.textContent?.trim();
      throw new Error(notice ? `找不到下载链接：${notice}` : '作品页没有找到 EPUB 或 PDF 下载链接');
    }

    return { title, links };
  }

  async function loadWork(work, settings) {
    const url = `${work.url}?view_adult=true`;
    const timeoutMs = Math.max(10, Number(settings.requestTimeoutSeconds) || 60) * 1000;
    const maxRetries = Math.max(0, Number(settings.maxRetries) || 0);
    let attempt = 0;

    while (true) {
      await waitWhilePaused();
      if (runtime.stopped) throw new Error('任务已停止');

      try {
        const response = await gmRequestText(url, timeoutMs);

        if (response.status === 429) {
          const seconds = retryAfterSeconds(response.headers);
          log(`AO3 要求暂停请求，等待 ${seconds} 秒后继续。`, 'warn');
          setStatus(`请求过多，暂停 ${seconds} 秒`);
          await interruptibleSleep(seconds * 1000);
          continue;
        }

        if (RETRY_STATUS.has(response.status) || looksLikeCloudflare(response.text)) {
          throw new Error(`AO3 暂时不可用（HTTP ${response.status || 'Cloudflare'}）`);
        }

        if (response.status < 200 || response.status >= 400) {
          throw new Error(`读取作品页失败（HTTP ${response.status}）`);
        }

        return parseWorkDocument(response.text, response.finalUrl);
      } catch (error) {
        if (attempt >= maxRetries) throw error;
        attempt += 1;
        const delaySeconds = Math.min(30, 2 ** attempt);
        log(`读取失败，${delaySeconds} 秒后重试 ${attempt}/${maxRetries}：${error.message}`, 'warn');
        await interruptibleSleep(delaySeconds * 1000);
      }
    }
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
            reject(new Error('文件下载超时'));
          },
        });
        if (handle) runtime.activeDownloads.add(handle);
      } catch (error) {
        reject(error);
      }
    });
  }

  function abortActiveDownloads() {
    for (const handle of runtime.activeDownloads) {
      try { handle?.abort?.(); } catch { /* 忽略 */ }
    }
    runtime.activeDownloads.clear();
  }

  function formatSucceeded(records, workId, format) {
    return records?.[workId]?.formats?.[format]?.status === 'success';
  }

  function updateRecord(records, work, title, format, status, extra = {}) {
    if (!records[work.id]) {
      records[work.id] = { id: work.id, url: work.url, title: title || '', formats: {} };
    }
    records[work.id].url = work.url;
    if (title) records[work.id].title = title;
    records[work.id].formats[format] = {
      status,
      updatedAt: new Date().toISOString(),
      ...extra,
    };
    saveRecords(records);
  }

  async function downloadQueue() {
    const settings = readSettingsFromUi();
    const formats = getSelectedFormats(settings);
    if (!runtime.works.length) throw new Error('请先导入 TXT 文件');
    if (!formats.length) throw new Error('至少选择 EPUB 或 PDF 一种格式');

    saveSettings(settings);
    runtime.running = true;
    runtime.paused = false;
    runtime.stopped = false;
    runtime.currentIndex = 0;
    runtime.stats = { success: 0, failed: 0, skipped: 0 };
    refreshUi();

    const records = loadRecords();
    log(`开始处理 ${runtime.works.length} 部作品，格式：${formats.join('、')}。`);

    try {
      for (let index = 0; index < runtime.works.length; index += 1) {
        await waitWhilePaused();
        if (runtime.stopped) break;

        const work = runtime.works[index];
        runtime.currentIndex = index;
        refreshUi();

        const pendingFormats = formats.filter((format) => {
          if (settings.skipDownloaded && formatSucceeded(records, work.id, format)) {
            runtime.stats.skipped += 1;
            log(`跳过已完成：${work.url} [${format}]`);
            return false;
          }
          return true;
        });

        if (!pendingFormats.length) {
          runtime.currentIndex = index + 1;
          refreshUi();
          continue;
        }

        setStatus(`读取作品 ${index + 1}/${runtime.works.length}：${work.url}`);
        let workData;
        try {
          workData = await loadWork(work, settings);
        } catch (error) {
          pendingFormats.forEach((format) => {
            runtime.stats.failed += 1;
            updateRecord(records, work, '', format, 'failed', { error: error.message });
          });
          log(`${work.url}：${error.message}`, 'error');
          runtime.currentIndex = index + 1;
          refreshUi();
          if (index < runtime.works.length - 1) {
            await interruptibleSleep(Math.max(0, settings.workDelaySeconds) * 1000);
          }
          continue;
        }

        for (let formatIndex = 0; formatIndex < pendingFormats.length; formatIndex += 1) {
          await waitWhilePaused();
          if (runtime.stopped) break;

          const format = pendingFormats[formatIndex];
          const downloadUrl = workData.links[format];
          if (!downloadUrl) {
            runtime.stats.failed += 1;
            updateRecord(records, work, workData.title, format, 'failed', {
              error: `作品页没有 ${format} 下载链接`,
            });
            log(`${workData.title} [${format}]：没有找到下载链接`, 'error');
            refreshUi();
            continue;
          }

          const filename = filenameFromDownloadUrl(downloadUrl, format, work.id);
          setStatus(`下载 ${index + 1}/${runtime.works.length}：${filename}`);
          log(`开始下载：${filename}`);

          try {
            await gmDownloadFile(downloadUrl, filename);
            runtime.stats.success += 1;
            updateRecord(records, work, workData.title, format, 'success', { filename, downloadUrl });
            log(`完成：${filename}`, 'success');
          } catch (error) {
            runtime.stats.failed += 1;
            updateRecord(records, work, workData.title, format, 'failed', {
              filename,
              downloadUrl,
              error: error.message,
            });
            log(`${filename}：${error.message}`, 'error');
          }

          refreshUi();
          if (formatIndex < pendingFormats.length - 1) {
            await interruptibleSleep(Math.max(0, settings.formatDelaySeconds) * 1000);
          }
        }

        runtime.currentIndex = index + 1;
        refreshUi();
        if (runtime.stopped) break;

        if (index < runtime.works.length - 1) {
          await interruptibleSleep(Math.max(0, settings.workDelaySeconds) * 1000);
        }
      }

      if (runtime.stopped) {
        setStatus('任务已停止');
        log('任务已停止。', 'warn');
      } else {
        setStatus('任务完成');
        log(`任务完成。成功 ${runtime.stats.success}，失败 ${runtime.stats.failed}，跳过 ${runtime.stats.skipped}。`, 'success');
      }
    } finally {
      runtime.running = false;
      runtime.paused = false;
      refreshUi();
    }
  }

  function interruptibleSleep(ms) {
    const end = Date.now() + Math.max(0, ms);
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (runtime.stopped) {
          reject(new Error('任务已停止'));
          return;
        }
        if (Date.now() >= end) {
          resolve();
          return;
        }
        setTimeout(tick, Math.min(250, end - Date.now()));
      };
      tick();
    });
  }

  async function waitWhilePaused() {
    while (runtime.paused && !runtime.stopped) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  function saveTextFile(filename, content, type = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function timestampForFilename() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  function exportNormalizedTxt() {
    if (!runtime.works.length) return alert('当前没有已导入的作品链接');
    saveTextFile(`ao3-normalized-links-${timestampForFilename()}.txt`, `${runtime.works.map((work) => work.url).join('\n')}\n`);
  }

  function exportInvalidTxt() {
    if (!runtime.invalidLines.length) return alert('没有无法识别的行');
    const content = runtime.invalidLines.map((item) => `${item.lineNumber}\t${item.text}`).join('\n');
    saveTextFile(`ao3-invalid-lines-${timestampForFilename()}.txt`, `${content}\n`);
  }

  function exportFailedTxt() {
    const settings = readSettingsFromUi();
    const formats = getSelectedFormats(settings);
    const records = loadRecords();
    const urls = runtime.works
      .filter((work) => formats.some((format) => records?.[work.id]?.formats?.[format]?.status === 'failed'))
      .map((work) => work.url);
    if (!urls.length) return alert('当前队列没有失败记录');
    saveTextFile(`ao3-failed-links-${timestampForFilename()}.txt`, `${urls.join('\n')}\n`);
  }

  function exportRecordsJson() {
    saveTextFile(
      `ao3-download-records-${timestampForFilename()}.json`,
      `${JSON.stringify(loadRecords(), null, 2)}\n`,
      'application/json;charset=utf-8',
    );
  }

  async function handleFile(file) {
    if (!file) return;
    const text = await file.text();
    const result = parseTxt(text);
    runtime.works = result.works;
    runtime.invalidLines = result.invalidLines;
    runtime.sourceName = file.name;
    runtime.totalNonEmptyLines = result.totalNonEmptyLines;
    runtime.duplicateCount = result.duplicateCount;
    runtime.currentIndex = 0;
    runtime.stats = { success: 0, failed: 0, skipped: 0 };
    persistQueue();
    setStatus(`已导入 ${runtime.works.length} 部作品`);
    log(`导入 ${file.name}：识别 ${runtime.works.length} 部，重复 ${runtime.duplicateCount} 条，无法识别 ${runtime.invalidLines.length} 行。`, 'success');
    refreshUi();
  }

  function readSettingsFromUi() {
    const formats = [];
    if (ui.epub.checked) formats.push('EPUB');
    if (ui.pdf.checked) formats.push('PDF');
    return {
      formats,
      skipDownloaded: ui.skipDownloaded.checked,
      workDelaySeconds: Math.max(0, Number(ui.workDelay.value) || 0),
      formatDelaySeconds: Math.max(0, Number(ui.formatDelay.value) || 0),
      maxRetries: Math.max(0, Math.min(10, Number(ui.maxRetries.value) || 0)),
      requestTimeoutSeconds: Math.max(10, Number(ui.requestTimeout.value) || 60),
    };
  }

  function writeSettingsToUi(settings) {
    ui.epub.checked = settings.formats.includes('EPUB');
    ui.pdf.checked = settings.formats.includes('PDF');
    ui.skipDownloaded.checked = Boolean(settings.skipDownloaded);
    ui.workDelay.value = settings.workDelaySeconds;
    ui.formatDelay.value = settings.formatDelaySeconds;
    ui.maxRetries.value = settings.maxRetries;
    ui.requestTimeout.value = settings.requestTimeoutSeconds;
  }

  function setStatus(text) {
    if (ui.status) ui.status.textContent = text;
  }

  function log(message, level = 'info') {
    if (!ui.log) return;
    const row = document.createElement('div');
    row.className = `ao3txt-log-${level}`;
    row.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    ui.log.appendChild(row);
    while (ui.log.childElementCount > 300) ui.log.firstElementChild.remove();
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function queueSummaryText() {
    if (!runtime.works.length) return '尚未导入 TXT 文件';
    return `${runtime.sourceName}：${runtime.works.length} 部作品；重复 ${runtime.duplicateCount} 条；无法识别 ${runtime.invalidLines.length} 行`;
  }

  function refreshUi() {
    if (!ui.panel) return;
    ui.queueSummary.textContent = queueSummaryText();
    ui.progress.textContent = `${runtime.currentIndex}/${runtime.works.length}`;
    ui.success.textContent = runtime.stats.success;
    ui.failed.textContent = runtime.stats.failed;
    ui.skipped.textContent = runtime.stats.skipped;

    const percent = runtime.works.length ? Math.min(100, (runtime.currentIndex / runtime.works.length) * 100) : 0;
    ui.progressBar.style.width = `${percent}%`;

    ui.importButton.disabled = runtime.running;
    ui.startButton.disabled = runtime.running || !runtime.works.length;
    ui.pauseButton.disabled = !runtime.running || runtime.paused;
    ui.resumeButton.disabled = !runtime.running || !runtime.paused;
    ui.stopButton.disabled = !runtime.running;
    ui.clearQueueButton.disabled = runtime.running || !runtime.works.length;
    ui.exportNormalizedButton.disabled = !runtime.works.length;
    ui.exportInvalidButton.disabled = !runtime.invalidLines.length;
  }

  function createUi() {
    GM_addStyle(`
      #ao3txt-launcher { position: fixed; right: 18px; bottom: 22px; z-index: 99998; border: 0; border-radius: 999px; padding: 10px 15px; background: #7b1e2b; color: #fff; font: 14px/1.2 system-ui, sans-serif; cursor: pointer; box-shadow: 0 3px 14px rgba(0,0,0,.28); }
      #ao3txt-panel { position: fixed; right: 18px; bottom: 70px; z-index: 99999; width: min(460px, calc(100vw - 28px)); max-height: calc(100vh - 90px); overflow: auto; box-sizing: border-box; border: 1px solid #bbb; border-radius: 10px; padding: 14px; background: #fff; color: #222; font: 13px/1.45 system-ui, sans-serif; box-shadow: 0 8px 32px rgba(0,0,0,.3); display: none; }
      #ao3txt-panel * { box-sizing: border-box; }
      #ao3txt-panel h2 { margin: 0; font-size: 17px; }
      #ao3txt-panel h3 { margin: 13px 0 7px; font-size: 14px; }
      #ao3txt-panel button { border: 1px solid #999; border-radius: 5px; padding: 6px 9px; background: #f6f6f6; color: #222; cursor: pointer; }
      #ao3txt-panel button.primary { background: #7b1e2b; border-color: #7b1e2b; color: #fff; }
      #ao3txt-panel button:disabled { opacity: .45; cursor: not-allowed; }
      #ao3txt-panel input[type="number"] { width: 68px; padding: 4px; }
      .ao3txt-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 7px 0; }
      .ao3txt-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .ao3txt-muted { color: #666; font-size: 12px; overflow-wrap: anywhere; }
      .ao3txt-box { border: 1px solid #ddd; border-radius: 7px; padding: 9px; background: #fafafa; }
      .ao3txt-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; text-align: center; }
      .ao3txt-stat { border: 1px solid #ddd; border-radius: 6px; padding: 5px; background: #fff; }
      .ao3txt-progress-track { height: 8px; background: #e4e4e4; border-radius: 999px; overflow: hidden; }
      #ao3txt-progress-bar { height: 100%; width: 0; background: #7b1e2b; transition: width .2s; }
      #ao3txt-log { max-height: 190px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid #ddd; border-radius: 6px; padding: 7px; background: #111; color: #ddd; font: 12px/1.45 ui-monospace, monospace; }
      .ao3txt-log-success { color: #8ee28e; }
      .ao3txt-log-warn { color: #ffd66b; }
      .ao3txt-log-error { color: #ff8f8f; }
      #ao3txt-drop { border: 2px dashed #aaa; border-radius: 7px; padding: 14px; text-align: center; cursor: pointer; background: #fff; }
      #ao3txt-drop.drag { border-color: #7b1e2b; background: #fff2f4; }
      @media (prefers-color-scheme: dark) {
        #ao3txt-panel { background: #222; color: #eee; border-color: #555; }
        #ao3txt-panel button { background: #333; color: #eee; border-color: #666; }
        .ao3txt-box, #ao3txt-drop { background: #292929; border-color: #555; }
        .ao3txt-stat { background: #202020; border-color: #555; }
        .ao3txt-muted { color: #bbb; }
      }
    `);

    const launcher = document.createElement('button');
    launcher.id = 'ao3txt-launcher';
    launcher.textContent = 'TXT 批量下载';

    const panel = document.createElement('section');
    panel.id = 'ao3txt-panel';
    panel.innerHTML = `
      <div class="ao3txt-header">
        <h2>${APP_NAME} <small>v${APP_VERSION}</small></h2>
        <button type="button" data-action="close">关闭</button>
      </div>

      <h3>1. 导入网址 TXT</h3>
      <div id="ao3txt-drop">点击选择 TXT，或把文件拖到这里</div>
      <input id="ao3txt-file" type="file" accept=".txt,text/plain" hidden>
      <div id="ao3txt-queue-summary" class="ao3txt-muted">尚未导入 TXT 文件</div>
      <div class="ao3txt-row">
        <button type="button" data-action="import">选择 TXT</button>
        <button type="button" data-action="export-normalized">导出清洗后链接</button>
        <button type="button" data-action="export-invalid">导出无法识别的行</button>
        <button type="button" data-action="clear-queue">清空队列</button>
      </div>

      <h3>2. 下载设置</h3>
      <div class="ao3txt-box">
        <div class="ao3txt-row">
          <label><input id="ao3txt-epub" type="checkbox"> EPUB</label>
          <label><input id="ao3txt-pdf" type="checkbox"> PDF</label>
          <label><input id="ao3txt-skip" type="checkbox"> 跳过已成功下载</label>
        </div>
        <div class="ao3txt-row">
          <label>作品间隔 <input id="ao3txt-work-delay" type="number" min="0" step="1"> 秒</label>
          <label>格式间隔 <input id="ao3txt-format-delay" type="number" min="0" step="1"> 秒</label>
        </div>
        <div class="ao3txt-row">
          <label>失败重试 <input id="ao3txt-retries" type="number" min="0" max="10" step="1"> 次</label>
          <label>读取超时 <input id="ao3txt-timeout" type="number" min="10" step="10"> 秒</label>
        </div>
      </div>

      <h3>3. 开始下载</h3>
      <div class="ao3txt-row">
        <button class="primary" type="button" data-action="start">开始</button>
        <button type="button" data-action="pause">暂停</button>
        <button type="button" data-action="resume">继续</button>
        <button type="button" data-action="stop">停止</button>
      </div>
      <div class="ao3txt-progress-track"><div id="ao3txt-progress-bar"></div></div>
      <div class="ao3txt-stats" style="margin-top:7px">
        <div class="ao3txt-stat">进度<br><strong id="ao3txt-progress">0/0</strong></div>
        <div class="ao3txt-stat">成功<br><strong id="ao3txt-success">0</strong></div>
        <div class="ao3txt-stat">失败<br><strong id="ao3txt-failed">0</strong></div>
        <div class="ao3txt-stat">跳过<br><strong id="ao3txt-skipped">0</strong></div>
      </div>
      <div id="ao3txt-status" class="ao3txt-muted" style="margin-top:7px">等待导入 TXT</div>

      <h3>记录</h3>
      <div class="ao3txt-row">
        <button type="button" data-action="export-failed">导出失败链接</button>
        <button type="button" data-action="export-records">导出完整记录</button>
        <button type="button" data-action="clear-records">清空下载记录</button>
      </div>
      <div id="ao3txt-log"></div>
    `;

    document.body.append(launcher, panel);

    ui.panel = panel;
    ui.file = panel.querySelector('#ao3txt-file');
    ui.drop = panel.querySelector('#ao3txt-drop');
    ui.queueSummary = panel.querySelector('#ao3txt-queue-summary');
    ui.epub = panel.querySelector('#ao3txt-epub');
    ui.pdf = panel.querySelector('#ao3txt-pdf');
    ui.skipDownloaded = panel.querySelector('#ao3txt-skip');
    ui.workDelay = panel.querySelector('#ao3txt-work-delay');
    ui.formatDelay = panel.querySelector('#ao3txt-format-delay');
    ui.maxRetries = panel.querySelector('#ao3txt-retries');
    ui.requestTimeout = panel.querySelector('#ao3txt-timeout');
    ui.progressBar = panel.querySelector('#ao3txt-progress-bar');
    ui.progress = panel.querySelector('#ao3txt-progress');
    ui.success = panel.querySelector('#ao3txt-success');
    ui.failed = panel.querySelector('#ao3txt-failed');
    ui.skipped = panel.querySelector('#ao3txt-skipped');
    ui.status = panel.querySelector('#ao3txt-status');
    ui.log = panel.querySelector('#ao3txt-log');
    ui.importButton = panel.querySelector('[data-action="import"]');
    ui.startButton = panel.querySelector('[data-action="start"]');
    ui.pauseButton = panel.querySelector('[data-action="pause"]');
    ui.resumeButton = panel.querySelector('[data-action="resume"]');
    ui.stopButton = panel.querySelector('[data-action="stop"]');
    ui.clearQueueButton = panel.querySelector('[data-action="clear-queue"]');
    ui.exportNormalizedButton = panel.querySelector('[data-action="export-normalized"]');
    ui.exportInvalidButton = panel.querySelector('[data-action="export-invalid"]');

    writeSettingsToUi(loadSettings());

    const togglePanel = (force) => {
      const show = typeof force === 'boolean' ? force : panel.style.display === 'none';
      panel.style.display = show ? 'block' : 'none';
    };

    launcher.addEventListener('click', () => togglePanel());
    panel.querySelector('[data-action="close"]').addEventListener('click', () => togglePanel(false));
    ui.importButton.addEventListener('click', () => ui.file.click());
    ui.drop.addEventListener('click', () => ui.file.click());
    ui.file.addEventListener('change', () => handleFile(ui.file.files?.[0]).catch((error) => alert(error.message)));

    ['dragenter', 'dragover'].forEach((eventName) => {
      ui.drop.addEventListener(eventName, (event) => {
        event.preventDefault();
        ui.drop.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach((eventName) => {
      ui.drop.addEventListener(eventName, (event) => {
        event.preventDefault();
        ui.drop.classList.remove('drag');
      });
    });
    ui.drop.addEventListener('drop', (event) => {
      handleFile(event.dataTransfer?.files?.[0]).catch((error) => alert(error.message));
    });

    panel.querySelector('[data-action="export-normalized"]').addEventListener('click', exportNormalizedTxt);
    panel.querySelector('[data-action="export-invalid"]').addEventListener('click', exportInvalidTxt);
    panel.querySelector('[data-action="export-failed"]').addEventListener('click', exportFailedTxt);
    panel.querySelector('[data-action="export-records"]').addEventListener('click', exportRecordsJson);

    panel.querySelector('[data-action="clear-queue"]').addEventListener('click', () => {
      if (!confirm('清空当前导入队列？下载记录会保留。')) return;
      runtime.works = [];
      runtime.invalidLines = [];
      runtime.sourceName = '';
      runtime.totalNonEmptyLines = 0;
      runtime.duplicateCount = 0;
      GM_deleteValue(STORAGE_QUEUE);
      GM_deleteValue(STORAGE_INVALID);
      setStatus('队列已清空');
      refreshUi();
    });

    panel.querySelector('[data-action="clear-records"]').addEventListener('click', () => {
      if (!confirm('清空所有下载记录？清空后会重新下载曾经成功的文件。')) return;
      GM_deleteValue(STORAGE_RECORDS);
      log('下载记录已清空。', 'warn');
    });

    ui.startButton.addEventListener('click', () => downloadQueue().catch((error) => {
      if (error.message !== '任务已停止') {
        setStatus(error.message);
        log(error.message, 'error');
      }
      runtime.running = false;
      runtime.paused = false;
      refreshUi();
    }));

    ui.pauseButton.addEventListener('click', () => {
      runtime.paused = true;
      setStatus('已暂停');
      log('任务已暂停。', 'warn');
      refreshUi();
    });

    ui.resumeButton.addEventListener('click', () => {
      runtime.paused = false;
      setStatus('继续运行');
      log('任务继续。');
      refreshUi();
    });

    ui.stopButton.addEventListener('click', () => {
      runtime.stopped = true;
      runtime.paused = false;
      abortActiveDownloads();
      setStatus('正在停止');
      refreshUi();
    });

    [ui.epub, ui.pdf, ui.skipDownloaded, ui.workDelay, ui.formatDelay, ui.maxRetries, ui.requestTimeout]
      .forEach((element) => element.addEventListener('change', () => saveSettings(readSettingsFromUi())));

    GM_registerMenuCommand(`${APP_NAME}：打开面板`, () => togglePanel(true));
    refreshUi();
    if (runtime.works.length) setStatus(`已恢复上次导入的 ${runtime.works.length} 部作品`);
  }

  restoreQueue();
  createUi();
})();
