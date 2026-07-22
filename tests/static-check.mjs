import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, '..', 'ao3-batch-downloader.user.js');
const source = fs.readFileSync(scriptPath, 'utf8');

for (const required of [
  '// @grant        GM_download',
  '// @grant        GM_getValue',
  '// @match        https://archiveofourown.org/*',
  'GPL-3.0-only',
  'EPUB',
  'PDF',
]) {
  assert.ok(source.includes(required), `缺少必要内容：${required}`);
}

new vm.Script(source, { filename: scriptPath });

const context = {
  console,
  URL,
  Blob,
  Date,
  Number,
  String,
  Set,
  Map,
  Promise,
  globalThis: null,
  __AO3BD_TEST_MODE__: true,
  window: {
    location: { origin: 'https://archiveofourown.org', href: 'https://archiveofourown.org/tags/Test/works' },
    setTimeout,
    clearTimeout,
  },
  document: {},
  GM_getValue: (_key, fallback) => fallback,
  GM_setValue: () => {},
  GM_deleteValue: () => {},
  GM_addStyle: () => {},
  GM_download: () => ({ abort() {} }),
  GM_registerMenuCommand: () => {},
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: scriptPath });

const api = context.__AO3BD_TEST_API__;
assert.ok(api, '测试 API 未暴露');

assert.equal(api.extractWorkId('/works/87836186/chapters/1#workskin'), '87836186');
assert.equal(api.extractWorkId('work-12345 work blurb group'), '12345');
assert.equal(api.extractWorkId('/works/search'), null);
assert.deepEqual([...api.parseTerms('A\n\nB, C\n')], ['A', 'B, C']);
assert.equal(api.parseNonNegativeNumber('12,345'), 12345);
assert.equal(api.parseNonNegativeNumber(''), null);
assert.deepEqual({ ...api.parseChapterStats('12/12') }, { current: 12, total: 12, complete: true });
assert.deepEqual({ ...api.parseChapterStats('3/?') }, { current: 3, total: null, complete: false });
assert.equal(api.normalizeRating('rating-explicit Explicit'), 'Explicit');
assert.deepEqual([...api.normalizeCategories(['M/M', 'category-gen'])], ['M/M', 'Gen']);
assert.equal(
  api.filenameFromDownloadUrl(
    'https://download.archiveofourown.org/downloads/123/My%20Work.epub?updated_at=1',
    'EPUB',
    '123',
  ),
  'My Work.epub',
);

const work = {
  complete: true,
  words: 12500,
  rating: 'Explicit',
  categories: ['M/M'],
  language: 'English',
  fandoms: ['Example Fandom'],
  relationships: ['A/B'],
  characters: ['A', 'B'],
  additionalTags: ['Slow Burn', 'Happy Ending'],
  warnings: ['No Archive Warnings Apply'],
};
const settings = {
  completion: 'complete',
  minWords: '10000',
  maxWords: '20000',
  ratings: ['Explicit'],
  categories: ['M/M'],
  languages: 'English',
  fandoms: 'Example Fandom',
  relationships: 'A/B',
  characters: '',
  additionalTags: 'Slow Burn',
  excludeWarnings: '',
  excludeRelationships: '',
  excludeCharacters: '',
  excludeAdditionalTags: 'Major Character Death',
  includeMode: 'any',
  tagMatchMode: 'exact',
};
assert.equal(api.workMatchesFilters(work, settings), true);
assert.equal(api.workMatchesFilters(work, { ...settings, excludeAdditionalTags: 'Happy Ending' }), false);
assert.equal(api.workMatchesFilters(work, { ...settings, minWords: '13000' }), false);

console.log('静态检查和核心函数测试通过。');
