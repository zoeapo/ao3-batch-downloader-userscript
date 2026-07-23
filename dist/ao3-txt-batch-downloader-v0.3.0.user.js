// ==UserScript==
// @name         AO3 TXT 批量作品下载器
// @namespace    https://github.com/zoeapo/ao3-batch-downloader-userscript
// @version      0.3.0
// @description  导入包含 AO3 作品网址的 TXT 文件，自动清洗、去重，并以随机间隔批量下载官方 EPUB 和 PDF；Chrome 可选择本地保存文件夹。
// @author       zoeapo
// @license      GPL-3.0-only
// @homepageURL  https://github.com/zoeapo/ao3-batch-downloader-userscript
// @supportURL   https://github.com/zoeapo/ao3-batch-downloader-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/zoeapo/ao3-batch-downloader-userscript/main/ao3-txt-batch-downloader.user.js
// @updateURL    https://raw.githubusercontent.com/zoeapo/ao3-batch-downloader-userscript/main/ao3-txt-batch-downloader.user.js
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
  const APP_VERSION = '0.3.0';
  const CANONICAL_ORIGIN = 'https://archiveofourown.org';
  const DIRECTORY_DB_NAME = 'ao3txt.filesystem.v1';
  const DIRECTORY_STORE_NAME = 'handles';
  const DIRECTORY_HANDLE_KEY = 'download-directory';
  const STORAGE_SETTINGS = 'ao3txt.settings.v2';
  const STORAGE_RECORDS = 'ao3txt.records.v2';
  const STORAGE_QUEUE = 'ao3txt.queue.v2';
  const STORAGE_INVALID = 'ao3txt.invalid.v2';

  const DEFAULT_SETTINGS = Object.freeze({
    formats: ['EPUB', 'PDF'],
    skipDownloaded: true,
    workDelayMinSeconds: 10,
    workDelayMaxSeconds: 15,
    formatDelayMinSeconds: 1,
    formatDelayMaxSeconds: 3,
    retryDelayMinSeconds: 5,
    retryDelayMaxSeconds: 15,
    maxRetries: 2,
    requestTimeoutSeconds: 60,
    useSelectedDirectory: false,
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
    directoryHandle: null,
    directoryPermission: 'none',
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

  function supportsDirectoryPicker() {
    return typeof window.showDirectoryPicker === 'function';
  }

  function openDirectoryDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('当前浏览器无法保存文件夹授权信息'));
        return;
      }
      const request = window.indexedDB.open(DIRECTORY_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(DIRECTORY_STORE_NAME)) {
          database.createObjectStore(DIRECTORY_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开文件夹授权数据库'));
    });
  }

  async function readStoredDirectoryHandle() {
    const database = await openDirectoryDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(DIRECTORY_STORE_NAME, 'readonly');
        const request = transaction.objectStore(DIRECTORY_STORE_NAME).get(DIRECTORY_HANDLE_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('无法读取已保存的文件夹'));
      });
    } finally {
      database.close();
    }
  }

  async function storeDirectoryHandle(handle) {
    const database = await openDirectoryDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(DIRECTORY_STORE_NAME, 'readwrite');
        transaction.objectStore(DIRECTORY_STORE_NAME).put(handle, DIRECTORY_HANDLE_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('无法保存文件夹授权'));
        transaction.onabort = () => reject(transaction.error || new Error('保存文件夹授权被中止'));
      });
    } finally {
      database.close();
    }
  }

  async function deleteStoredDirectoryHandle() {
    const database = await openDirectoryDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(DIRECTORY_STORE_NAME, 'readwrite');
        transaction.objectStore(DIRECTORY_STORE_NAME).delete(DIRECTORY_HANDLE_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('无法清除文件夹授权'));
        transaction.onabort = () => reject(transaction.error || new Error('清除文件夹授权被中止'));
      });
    } finally {
      database.close();
    }
  }

  async function queryDirectoryPermission(handle) {
    if (!handle) return 'none';
    if (typeof handle.queryPermission !== 'function') return 'prompt';
    try {
      return await handle.queryPermission({ mode: 'readwrite' });
    } catch {
      return 'prompt';
    }
  }

  async function restoreDirectoryHandle() {
    if (!supportsDirectoryPicker()) {
      runtime.directoryHandle = null;
      runtime.directoryPermission = 'unsupported';
      refreshDirectoryUi();
      return;
    }

    try {
      const handle = await readStoredDirectoryHandle();
      runtime.directoryHandle = handle;
      runtime.directoryPermission = handle ? await queryDirectoryPermission(handle) : 'none';
    } catch (error) {
      runtime.directoryHandle = null;
      runtime.directoryPermission = 'none';
      log(`恢复保存文件夹失败：${error.message}`, 'warn');
    }
    refreshDirectoryUi();
  }

  async function requestStoredDirectoryPermission() {
    const handle = runtime.directoryHandle;
    if (!handle) return 'none';

    let permission = 'prompt';
    if (typeof handle.requestPermission === 'function') {
      try {
        permission = await handle.requestPermission({ mode: 'readwrite' });
      } catch {
        permission = 'denied';
      }
    } else {
      permission = await queryDirectoryPermission(handle);
    }

    runtime.directoryPermission = permission;
    refreshDirectoryUi();
    return permission;
  }

  async function chooseDownloadDirectory() {
    if (!supportsDirectoryPicker()) {
      throw new Error('当前浏览器不支持直接选择保存文件夹，请使用最新版 Chrome');
    }

    if (runtime.directoryHandle) {
      const permission = await requestStoredDirectoryPermission();
      if (permission === 'granted') {
        log(`已重新获得文件夹写入权限：${runtime.directoryHandle.name}`, 'success');
        return runtime.directoryHandle;
      }
    }

    const handle = await window.showDirectoryPicker({
      id: 'ao3txt-download-folder',
      mode: 'readwrite',
      startIn: 'downloads',
    });

    runtime.directoryHandle = handle;
    runtime.directoryPermission = await queryDirectoryPermission(handle);
    await storeDirectoryHandle(handle);

    if (ui.useSelectedDirectory) {
      ui.useSelectedDirectory.checked = true;
      saveSettings(readSettingsFromUi());
    }

    refreshDirectoryUi();
    log(`已选择保存文件夹：${handle.name}`, 'success');
    return handle;
  }

  async function clearDownloadDirectory() {
    runtime.directoryHandle = null;
    runtime.directoryPermission = 'none';
    try {
      await deleteStoredDirectoryHandle();
    } catch (error) {
      log(`清除已保存文件夹时出现问题：${error.message}`, 'warn');
    }

    if (ui.useSelectedDirectory) {
      ui.useSelectedDirectory.checked = false;
      saveSettings(readSettingsFromUi());
    }

    refreshDirectoryUi();
    log('已取消保存文件夹选择，之后将使用浏览器默认下载目录。', 'warn');
  }

  async function prepareSelectedDirectory(settings) {
    if (!settings.useSelectedDirectory) return null;
    if (!supportsDirectoryPicker()) {
      throw new Error('当前浏览器不支持直接写入所选文件夹，请取消“保存到所选文件夹”');
    }
    if (!runtime.directoryHandle) {
      throw new Error('请先点击“选择保存文件夹”');
    }

    const permission = await requestStoredDirectoryPermission();
    if (permission !== 'granted') {
      throw new Error('没有所选文件夹的写入权限，请重新选择文件夹');
    }
    return runtime.directoryHandle;
  }

  async function entryExists(directoryHandle, filename) {
    try {
      await directoryHandle.getFileHandle(filename);
      return true;
    } catch (error) {
      if (error?.name === 'NotFoundError') return false;
      if (error?.name === 'TypeMismatchError') return true;
      throw error;
    }
  }

  async function uniqueFilenameInDirectory(directoryHandle, filename) {
    const safeName = sanitizeFilename(filename);
    if (!(await entryExists(directoryHandle, safeName))) return safeName;

    const dotIndex = safeName.lastIndexOf('.');
    const hasExtension = dotIndex > 0;
    const base = hasExtension ? safeName.slice(0, dotIndex) : safeName;
    const extension = hasExtension ? safeName.slice(dotIndex) : '';

    for (let index = 1; index <= 9999; index += 1) {
      const candidate = `${base} (${index})${extension}`;
      if (!(await entryExists(directoryHandle, candidate))) return candidate;
    }

    throw new Error(`文件名冲突过多：${safeName}`);
  }

  async function writeBlobToSelectedDirectory(blob, filename) {
    const directoryHandle = runtime.directoryHandle;
    if (!directoryHandle) throw new Error('没有可用的保存文件夹');

    const actualFilename = await uniqueFilenameInDirectory(directoryHandle, filename);
    const fileHandle = await directoryHandle.getFileHandle(actualFilename, { create: true });
    const writable = await fileHandle.createWritable();

    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch { /* 忽略关闭错误 */ }
      throw error;
    }

    return actualFilename;
  }

  function directoryStatusText() {
    if (!supportsDirectoryPicker()) return '当前浏览器不支持直接选择文件夹，将使用浏览器默认下载目录。';
    if (!runtime.directoryHandle) return '尚未选择文件夹，将使用浏览器默认下载目录。';

    const name = runtime.directoryHandle.name || '已选择的文件夹';
    if (runtime.directoryPermission === 'granted') return `当前文件夹：${name}（已授权）`;
    if (runtime.directoryPermission === 'denied') return `当前文件夹：${name}（权限被拒绝，请重新选择）`;
    return `当前文件夹：${name}（开始下载时可能需要重新授权）`;
  }

  function refreshDirectoryUi() {
    if (!ui.directoryStatus) return;
    ui.directoryStatus.textContent = directoryStatusText();

    const supported = supportsDirectoryPicker();
    const hasHandle = Boolean(runtime.directoryHandle);
    if (ui.selectDirectoryButton) {
      ui.selectDirectoryButton.disabled = runtime.running || !supported;
      ui.selectDirectoryButton.textContent = hasHandle ? '重新授权或更换文件夹' : '选择保存文件夹';
    }
    if (ui.clearDirectoryButton) {
      ui.clearDirectoryButton.disabled = runtime.running || !hasHandle;
    }
    if (ui.useSelectedDirectory) {
      ui.useSelectedDirectory.disabled = runtime.running || !supported || !hasHandle;
    }
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

  function normalizeDelayRange(minValue, maxValue, fallbackMin, fallbackMax) {
    let min = Number(minValue);
    let max = Number(maxValue);
    if (!Number.isFinite(min)) min = fallbackMin;
    if (!Number.isFinite(max)) max = fallbackMax;
    min = Math.max(0, Math.floor(min));
    max = Math.max(0, Math.floor(max));
    return min <= max ? [min, max] : [max, min];
  }

  function randomDelaySeconds(minValue, maxValue) {
    const [min, max] = normalizeDelayRange(minValue, maxValue, 0, 0);
    if (min === max) return min;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async function waitRandomDelay(label, minValue, maxValue) {
    const seconds = randomDelaySeconds(minValue, maxValue);
    if (seconds <= 0) return;
    log(`${label}：随机等待 ${seconds} 秒。`);
    setStatus(`${label}，等待 ${seconds} 秒`);
    await interruptibleSleep(seconds * 1000);
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
        const delaySeconds = randomDelaySeconds(settings.retryDelayMinSeconds, settings.retryDelayMaxSeconds);
        log(`读取失败，随机等待 ${delaySeconds} 秒后重试 ${attempt}/${maxRetries}：${error.message}`, 'warn');
        setStatus(`读取失败，${delaySeconds} 秒后重试`);
        await interruptibleSleep(delaySeconds * 1000);
      }
    }
  }

  function downloadBlobWithBrowser(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }

  function gmRequestBlob(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const request = GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: timeoutMs,
        anonymous: false,
        responseType: 'blob',
        onload: (response) => {
          runtime.activeDownloads.delete(request);
          if (response.status < 200 || response.status >= 400) {
            reject(new Error(`读取下载文件失败（HTTP ${response.status}）`));
            return;
          }
          if (!(response.response instanceof Blob) || response.response.size === 0) {
            reject(new Error('读取到的下载文件为空'));
            return;
          }
          resolve(response.response);
        },
        onerror: (error) => {
          runtime.activeDownloads.delete(request);
          reject(new Error(error?.error || '读取下载文件失败'));
        },
        ontimeout: () => {
          runtime.activeDownloads.delete(request);
          reject(new Error('读取下载文件超时'));
        },
      });
      if (request) runtime.activeDownloads.add(request);
    });
  }

  async function downloadThroughBlob(url, filename, timeoutMs) {
    const blob = await gmRequestBlob(url, timeoutMs);
    downloadBlobWithBrowser(blob, filename);
  }

  async function downloadToSelectedDirectory(url, filename, timeoutMs) {
    const blob = await gmRequestBlob(url, timeoutMs);
    const actualFilename = await writeBlobToSelectedDirectory(blob, filename);
    return { method: 'selected-directory', filename: actualFilename };
  }

  function gmDownloadFile(url, filename, timeoutMs) {
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
            resolve({ method: 'GM_download' });
          },
          onerror: async (error) => {
            runtime.activeDownloads.delete(handle);
            const reason = error?.error || 'not_succeeded';
            const details = error?.details ? `：${error.details}` : '';

            if (reason === 'not_whitelisted') {
              try {
                log(`${filename}：扩展名被 Tampermonkey 拦截，改用浏览器文件方式下载。`, 'warn');
                await downloadThroughBlob(url, filename, timeoutMs);
                resolve({ method: 'blob-fallback' });
              } catch (fallbackError) {
                reject(new Error(`Tampermonkey 拒绝该扩展名，备用下载也失败：${fallbackError.message}`));
              }
              return;
            }

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

  async function downloadFileWithRetry(url, filename, settings) {
    const maxRetries = Math.max(0, Number(settings.maxRetries) || 0);
    const timeoutMs = Math.max(10, Number(settings.requestTimeoutSeconds) || 60) * 1000;
    let attempt = 0;

    while (true) {
      await waitWhilePaused();
      if (runtime.stopped) throw new Error('任务已停止');

      try {
        if (settings.useSelectedDirectory) {
          return await downloadToSelectedDirectory(url, filename, timeoutMs);
        }
        return await gmDownloadFile(url, filename, timeoutMs);
      } catch (error) {
        if (attempt >= maxRetries) throw error;
        attempt += 1;
        const delaySeconds = randomDelaySeconds(settings.retryDelayMinSeconds, settings.retryDelayMaxSeconds);
        log(`${filename}：下载失败，随机等待 ${delaySeconds} 秒后重试 ${attempt}/${maxRetries}：${error.message}`, 'warn');
        setStatus(`下载失败，${delaySeconds} 秒后重试`);
        await interruptibleSleep(delaySeconds * 1000);
      }
    }
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

    await prepareSelectedDirectory(settings);
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
            await waitRandomDelay('下一部作品前', settings.workDelayMinSeconds, settings.workDelayMaxSeconds);
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
            const result = await downloadFileWithRetry(downloadUrl, filename, settings);
            const actualFilename = result?.filename || filename;
            runtime.stats.success += 1;
            updateRecord(records, work, workData.title, format, 'success', {
              filename: actualFilename,
              downloadUrl,
              downloadMethod: result?.method || 'unknown',
              directoryName: result?.method === 'selected-directory' ? runtime.directoryHandle?.name || '' : '',
            });
            const methodNote = result?.method === 'blob-fallback'
              ? '（备用下载）'
              : result?.method === 'selected-directory'
                ? `（已保存到 ${runtime.directoryHandle?.name || '所选文件夹'}）`
                : '';
            log(`完成：${actualFilename}${methodNote}`, 'success');
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
            await waitRandomDelay('下一种格式前', settings.formatDelayMinSeconds, settings.formatDelayMaxSeconds);
          }
        }

        runtime.currentIndex = index + 1;
        refreshUi();
        if (runtime.stopped) break;

        if (index < runtime.works.length - 1) {
          await waitRandomDelay('下一部作品前', settings.workDelayMinSeconds, settings.workDelayMaxSeconds);
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
    const [workDelayMinSeconds, workDelayMaxSeconds] = normalizeDelayRange(
      ui.workDelayMin.value,
      ui.workDelayMax.value,
      DEFAULT_SETTINGS.workDelayMinSeconds,
      DEFAULT_SETTINGS.workDelayMaxSeconds,
    );
    const [formatDelayMinSeconds, formatDelayMaxSeconds] = normalizeDelayRange(
      ui.formatDelayMin.value,
      ui.formatDelayMax.value,
      DEFAULT_SETTINGS.formatDelayMinSeconds,
      DEFAULT_SETTINGS.formatDelayMaxSeconds,
    );
    const [retryDelayMinSeconds, retryDelayMaxSeconds] = normalizeDelayRange(
      ui.retryDelayMin.value,
      ui.retryDelayMax.value,
      DEFAULT_SETTINGS.retryDelayMinSeconds,
      DEFAULT_SETTINGS.retryDelayMaxSeconds,
    );
    return {
      formats,
      skipDownloaded: ui.skipDownloaded.checked,
      workDelayMinSeconds,
      workDelayMaxSeconds,
      formatDelayMinSeconds,
      formatDelayMaxSeconds,
      retryDelayMinSeconds,
      retryDelayMaxSeconds,
      maxRetries: Math.max(0, Math.min(10, Number(ui.maxRetries.value) || 0)),
      requestTimeoutSeconds: Math.max(10, Number(ui.requestTimeout.value) || 60),
      useSelectedDirectory: Boolean(ui.useSelectedDirectory?.checked),
    };
  }

  function writeSettingsToUi(settings) {
    ui.epub.checked = settings.formats.includes('EPUB');
    ui.pdf.checked = settings.formats.includes('PDF');
    ui.skipDownloaded.checked = Boolean(settings.skipDownloaded);
    ui.workDelayMin.value = settings.workDelayMinSeconds;
    ui.workDelayMax.value = settings.workDelayMaxSeconds;
    ui.formatDelayMin.value = settings.formatDelayMinSeconds;
    ui.formatDelayMax.value = settings.formatDelayMaxSeconds;
    ui.retryDelayMin.value = settings.retryDelayMinSeconds;
    ui.retryDelayMax.value = settings.retryDelayMaxSeconds;
    ui.maxRetries.value = settings.maxRetries;
    ui.requestTimeout.value = settings.requestTimeoutSeconds;
    ui.useSelectedDirectory.checked = Boolean(settings.useSelectedDirectory);
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
    refreshDirectoryUi();
  }

  function createUi() {
    GM_addStyle(`
      #ao3txt-launcher { position: fixed; right: 18px; bottom: 22px; z-index: 99998; border: 0; border-radius: 999px; padding: 10px 15px; background: #7b1e2b; color: #fff; font: 14px/1.2 system-ui, sans-serif; cursor: pointer; box-shadow: 0 3px 14px rgba(0,0,0,.28); }
      #ao3txt-panel { position: fixed; right: 18px; bottom: 70px; z-index: 99999; width: min(760px, calc(100vw - 36px)); min-width: min(560px, calc(100vw - 36px)); max-height: calc(100vh - 90px); overflow: auto; box-sizing: border-box; border: 1px solid #bbb; border-radius: 12px; padding: 18px; background: #fff; color: #222; font: 14px/1.55 system-ui, sans-serif; box-shadow: 0 8px 32px rgba(0,0,0,.3); display: none; resize: both; }
      #ao3txt-panel * { box-sizing: border-box; }
      #ao3txt-panel h2 { margin: 0; font-size: 19px; }
      #ao3txt-panel h3 { margin: 16px 0 8px; font-size: 15px; }
      #ao3txt-panel button { border: 1px solid #999; border-radius: 5px; padding: 7px 11px; background: #f6f6f6; color: #222; cursor: pointer; white-space: nowrap; }
      #ao3txt-panel button.primary { background: #7b1e2b; border-color: #7b1e2b; color: #fff; }
      #ao3txt-panel button:disabled { opacity: .45; cursor: not-allowed; }
      #ao3txt-panel input[type="number"] { width: 82px; padding: 5px 7px; }
      .ao3txt-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
      .ao3txt-row > label { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
      .ao3txt-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .ao3txt-muted { color: #666; font-size: 12px; overflow-wrap: anywhere; }
      .ao3txt-box { border: 1px solid #ddd; border-radius: 7px; padding: 9px; background: #fafafa; }
      .ao3txt-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; text-align: center; }
      .ao3txt-stat { border: 1px solid #ddd; border-radius: 6px; padding: 5px; background: #fff; }
      .ao3txt-progress-track { height: 8px; background: #e4e4e4; border-radius: 999px; overflow: hidden; }
      #ao3txt-progress-bar { height: 100%; width: 0; background: #7b1e2b; transition: width .2s; }
      #ao3txt-log { min-height: 180px; max-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid #ddd; border-radius: 6px; padding: 9px; background: #111; color: #ddd; font: 12px/1.5 ui-monospace, monospace; }
      .ao3txt-log-success { color: #8ee28e; }
      .ao3txt-log-warn { color: #ffd66b; }
      .ao3txt-log-error { color: #ff8f8f; }
      #ao3txt-drop { border: 2px dashed #aaa; border-radius: 7px; padding: 14px; text-align: center; cursor: pointer; background: #fff; }
      #ao3txt-drop.drag { border-color: #7b1e2b; background: #fff2f4; }
      @media (max-width: 620px) {
        #ao3txt-panel { right: 8px; bottom: 62px; width: calc(100vw - 16px); min-width: 0; max-height: calc(100vh - 74px); padding: 13px; resize: none; }
        #ao3txt-panel h2 { font-size: 17px; }
        .ao3txt-stats { grid-template-columns: repeat(2, 1fr); }
      }
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
          <button type="button" data-action="select-directory">选择保存文件夹</button>
          <button type="button" data-action="clear-directory">取消文件夹选择</button>
          <label><input id="ao3txt-use-directory" type="checkbox"> 保存到所选文件夹</label>
        </div>
        <div id="ao3txt-directory-status" class="ao3txt-muted">正在读取文件夹设置……</div>
        <div class="ao3txt-row">
          <label>作品间隔 <input id="ao3txt-work-delay-min" type="number" min="0" step="1"> 至 <input id="ao3txt-work-delay-max" type="number" min="0" step="1"> 秒</label>
        </div>
        <div class="ao3txt-row">
          <label>格式间隔 <input id="ao3txt-format-delay-min" type="number" min="0" step="1"> 至 <input id="ao3txt-format-delay-max" type="number" min="0" step="1"> 秒</label>
        </div>
        <div class="ao3txt-row">
          <label>失败重试间隔 <input id="ao3txt-retry-delay-min" type="number" min="0" step="1"> 至 <input id="ao3txt-retry-delay-max" type="number" min="0" step="1"> 秒</label>
        </div>
        <div class="ao3txt-row">
          <label>失败重试次数 <input id="ao3txt-retries" type="number" min="0" max="10" step="1"> 次</label>
          <label>读取超时 <input id="ao3txt-timeout" type="number" min="10" step="10"> 秒</label>
        </div>
        <div class="ao3txt-muted">每次等待都会在最小值和最大值之间重新随机取一个整数。AO3 返回 429 时，仍按服务器指定时间暂停。选择文件夹后，EPUB 和 PDF 会直接写入该文件夹；同名文件会自动加编号。未启用文件夹模式时，EPUB 被 Tampermonkey 拦截会自动使用备用下载。</div>
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
    ui.useSelectedDirectory = panel.querySelector('#ao3txt-use-directory');
    ui.directoryStatus = panel.querySelector('#ao3txt-directory-status');
    ui.selectDirectoryButton = panel.querySelector('[data-action="select-directory"]');
    ui.clearDirectoryButton = panel.querySelector('[data-action="clear-directory"]');
    ui.workDelayMin = panel.querySelector('#ao3txt-work-delay-min');
    ui.workDelayMax = panel.querySelector('#ao3txt-work-delay-max');
    ui.formatDelayMin = panel.querySelector('#ao3txt-format-delay-min');
    ui.formatDelayMax = panel.querySelector('#ao3txt-format-delay-max');
    ui.retryDelayMin = panel.querySelector('#ao3txt-retry-delay-min');
    ui.retryDelayMax = panel.querySelector('#ao3txt-retry-delay-max');
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
    ui.selectDirectoryButton.addEventListener('click', () => {
      chooseDownloadDirectory().catch((error) => {
        if (error?.name !== 'AbortError') {
          alert(error.message || '选择保存文件夹失败');
          log(`选择保存文件夹失败：${error.message || error}`, 'error');
        }
      });
    });
    ui.clearDirectoryButton.addEventListener('click', () => {
      clearDownloadDirectory().catch((error) => {
        alert(error.message || '取消文件夹选择失败');
      });
    });
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

    [
      ui.epub,
      ui.pdf,
      ui.skipDownloaded,
      ui.useSelectedDirectory,
      ui.workDelayMin,
      ui.workDelayMax,
      ui.formatDelayMin,
      ui.formatDelayMax,
      ui.retryDelayMin,
      ui.retryDelayMax,
      ui.maxRetries,
      ui.requestTimeout,
    ].forEach((element) => element.addEventListener('change', () => saveSettings(readSettingsFromUi())));

    GM_registerMenuCommand(`${APP_NAME}：打开面板`, () => togglePanel(true));
    refreshUi();
    restoreDirectoryHandle();
    if (runtime.works.length) setStatus(`已恢复上次导入的 ${runtime.works.length} 部作品`);
  }

  restoreQueue();
  createUi();
})();
