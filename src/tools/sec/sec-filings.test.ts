import { describe, expect, test } from 'bun:test';
import { buildArchiveUrl, htmlToText, selectDocumentChunks } from './sec-filings.js';

describe('buildArchiveUrl', () => {
  test('builds the canonical EDGAR primary-document URL', () => {
    expect(buildArchiveUrl(1652044, '0001652044-26-000048', 'goog-20260331.htm')).toBe(
      'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000048/goog-20260331.htm',
    );
  });
});

describe('htmlToText', () => {
  test('drops inline XBRL hidden facts while preserving filing prose', () => {
    const text = htmlToText(`
      <html><body>
        <ix:header><ix:hidden>goog:investigation0001652044</ix:hidden></ix:header>
        <div hidden>hidden taxonomy</div>
        <main>Part II Item 1A. Our business is subject to regulatory risk.</main>
      </body></html>
    `);
    expect(text).toContain('Part II Item 1A');
    expect(text).not.toContain('goog:investigation');
    expect(text).not.toContain('hidden taxonomy');
  });
});

describe('selectDocumentChunks', () => {
  test('returns matching filing text with adjacent context', () => {
    expect(selectDocumentChunks(['before', 'Risk Factors changed', 'after', 'other'], 'risk factors'))
      .toEqual(['before', 'Risk Factors changed', 'after']);
  });
});
