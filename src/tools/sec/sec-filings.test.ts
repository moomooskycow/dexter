import { describe, expect, test } from 'bun:test';
import { buildArchiveUrl } from './sec-filings.js';

describe('buildArchiveUrl', () => {
  test('builds the canonical EDGAR primary-document URL', () => {
    expect(buildArchiveUrl(1652044, '0001652044-26-000048', 'goog-20260331.htm')).toBe(
      'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000048/goog-20260331.htm',
    );
  });
});
