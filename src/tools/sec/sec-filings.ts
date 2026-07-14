import { DynamicStructuredTool } from '@langchain/core/tools';
import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { formatToolResult } from '../types.js';

const MAX_DOCUMENT_CHARS = 200_000;
const TICKER_CACHE_MS = 24 * 60 * 60 * 1000;

type TickerEntry = { cik_str: number; ticker: string; title: string };
type RecentFilings = Record<string, unknown[]>;
type FilingResult = Record<string, string> & {
  documentUrl: string;
  documentTextChunks?: string[];
  documentError?: string;
};

let tickerCache: { loadedAt: number; entries: TickerEntry[] } | null = null;

function secHeaders(accept: string): Record<string, string> {
  const userAgent = process.env.SEC_USER_AGENT?.trim();
  if (!userAgent) {
    throw new Error(
      'SEC_USER_AGENT is required and must identify a contact, for example "Dexter research you@example.com".',
    );
  }
  return {
    'User-Agent': userAgent,
    Accept: accept,
    'Accept-Encoding': 'gzip, deflate',
  };
}

async function secFetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: secHeaders('application/json'),
  });
  if (!response.ok) {
    throw new Error(`SEC request failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function resolveTicker(ticker: string): Promise<TickerEntry> {
  const now = Date.now();
  if (!tickerCache || now - tickerCache.loadedAt > TICKER_CACHE_MS) {
    const raw = await secFetchJson<Record<string, TickerEntry>>(
      'https://www.sec.gov/files/company_tickers.json',
    );
    tickerCache = { loadedAt: now, entries: Object.values(raw) };
  }
  const normalized = ticker.trim().toUpperCase();
  const entry = tickerCache.entries.find((candidate) => candidate.ticker.toUpperCase() === normalized);
  if (!entry) {
    throw new Error(`SEC ticker not found: ${normalized}`);
  }
  return entry;
}

export function buildArchiveUrl(cik: number, accession: string, primaryDocument: string): string {
  const accessionPath = accession.replaceAll('-', '');
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionPath}/${primaryDocument}`;
}

function rowsFromRecent(recent: RecentFilings): Record<string, string>[] {
  const accessions = recent.accessionNumber ?? [];
  return accessions.map((_, index) => {
    const row: Record<string, string> = {};
    for (const [key, values] of Object.entries(recent)) {
      const value = values[index];
      if (typeof value === 'string') row[key] = value;
    }
    return row;
  });
}

export function htmlToText(html: string): string {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll(
    'script, style, noscript, [hidden], ix\\:header, ix\\:hidden, [style*="display:none"], [style*="display: none"]',
  )) node.remove();
  return (document.body?.textContent ?? document.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_DOCUMENT_CHARS);
}

async function fetchDocument(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: secHeaders('text/html,application/xhtml+xml'),
  });
  if (!response.ok) {
    throw new Error(`SEC filing fetch failed: ${response.status} ${response.statusText}`);
  }
  return htmlToText(await response.text());
}

function chunkDocumentText(text: string, size = 1_200): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    chunks.push(text.slice(offset, offset + size));
  }
  return chunks;
}

export function selectDocumentChunks(chunks: string[], query?: string): string[] {
  const needle = query?.trim().toLowerCase();
  if (!needle) return chunks;
  const selected = new Set<number>();
  chunks.forEach((chunk, index) => {
    if (chunk.toLowerCase().includes(needle)) {
      if (index > 0) selected.add(index - 1);
      selected.add(index);
      if (index + 1 < chunks.length) selected.add(index + 1);
    }
  });
  return [...selected].sort((a, b) => a - b).map((index) => chunks[index]);
}

export const secFilingsTool = new DynamicStructuredTool({
  name: 'sec_filings',
  description:
    'Retrieve recent SEC filing metadata directly from EDGAR, with optional primary-document text. ' +
    'Use for 10-K, 10-Q, 8-K, Form 4, and other primary-source filing research without a paid provider.',
  schema: z.object({
    ticker: z.string().describe('Exact US-listed ticker symbol, for example GOOGL or ISRG.'),
    forms: z
      .array(z.string())
      .optional()
      .describe('Optional SEC form filters, for example ["10-Q", "8-K"] or ["4"].'),
    limit: z.number().int().min(1).max(10).optional().describe('Maximum filings to return. Default 5.'),
    include_document_text: z
      .boolean()
      .optional()
      .describe('Fetch primary-document text for up to 3 matched filings. Default false.'),
    document_query: z
      .string()
      .optional()
      .describe(
        'Optional case-insensitive phrase such as "risk factors". Returns matching document chunks plus adjacent context.',
      ),
  }),
  func: async (input) => {
    const company = await resolveTicker(input.ticker);
    const cik = String(company.cik_str).padStart(10, '0');
    const submissionsUrl = `https://data.sec.gov/submissions/CIK${cik}.json`;
    const submissions = await secFetchJson<{
      filings?: { recent?: RecentFilings };
    }>(submissionsUrl);
    const forms = new Set(input.forms?.map((form) => form.toUpperCase()) ?? []);
    const limit = input.limit ?? 5;
    const matches = rowsFromRecent(submissions.filings?.recent ?? {})
      .filter((row) => forms.size === 0 || forms.has((row.form ?? '').toUpperCase()))
      .slice(0, limit)
      .map((row): FilingResult => ({
        ...row,
        documentUrl: buildArchiveUrl(company.cik_str, row.accessionNumber, row.primaryDocument),
      }));

    if (input.include_document_text) {
      const documentLimit = input.document_query ? 1 : 3;
      for (const filing of matches.slice(0, documentLimit)) {
        try {
          const chunks = chunkDocumentText(await fetchDocument(filing.documentUrl));
          filing.documentTextChunks = selectDocumentChunks(chunks, input.document_query);
        } catch (error) {
          filing.documentError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    return formatToolResult(
      { company: company.title, ticker: company.ticker, cik, filings: matches },
      [submissionsUrl, ...matches.map((filing) => filing.documentUrl)],
    );
  },
});
