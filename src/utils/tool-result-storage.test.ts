import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { persistLargeResult } from './tool-result-storage.js';

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { force: true });
});

describe('persistLargeResult', () => {
  test('pretty prints JSON so read_file can paginate it by line', () => {
    const stored = persistLargeResult('sec_filings', 'pretty-json-test', '{"data":{"risk":"text"}}');
    created.push(stored.filePath);
    expect(stored.preview).toContain('\n  "data"');
    expect(stored.preview).toContain('\n    "risk"');
  });
});
