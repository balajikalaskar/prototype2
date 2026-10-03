import { createRequire } from 'node:module';
import type { load as CheerioLoad } from 'cheerio' with { 'resolution-mode': 'require' };
import { describe, expect, it } from 'vitest';
import { extractPage } from '../src/services/extraction.service.js';

const { load } = createRequire(import.meta.url)('cheerio') as { load: typeof CheerioLoad };
const limits = { maxTextLength: 50000, maxLinks: 100, maxHeadings: 100 };
const extract = (html: string, overrides = {}) =>
  extractPage(load(html), 'https://example.com/dir/page', { ...limits, ...overrides });

describe('HTML extraction', () => {
  it('extracts metadata, headings, and normalized body text without executable content', () => {
    const page = extract(`<!doctype html><html lang="en"><head><title> A   page </title>
      <meta name="DESCRIPTION" content=" A useful   description "></head><body>
      <h1>Hello <em>world</em></h1><h2> </h2><p>First</p><p>Second &amp; third</p>
      <script>secretScript()</script><style>.secret{}</style><template>secretTemplate</template>
      <noscript>secretNoscript</noscript><div hidden>secretHidden</div></body></html>`);
    expect(page).toMatchObject({
      title: 'A page', description: 'A useful description', language: 'en',
      headings: [{ level: 1, text: 'Hello world' }],
      text: 'Hello world First Second & third',
      textTruncated: false, linksTruncated: false, headingsTruncated: false,
    });
  });

  it('resolves base URLs and deduplicates fragment variants while filtering unusable links', () => {
    const page = extract(`<base href="/docs/"><body>
      <a href="guide#one">Guide</a><a href="guide#two">Duplicate</a>
      <a href="//other.example/path">External</a><a href="../about">About</a>
      <a href="#section">Anchor</a><a href="">Empty</a><a href="mailto:a@example.com">Email</a>
      <a href="javascript:alert(1)">JS</a><a href="https://user:pass@example.com">Credentials</a></body>`);
    expect(page.links).toEqual([
      { text: 'Guide', url: 'https://example.com/docs/guide' },
      { text: 'External', url: 'https://other.example/path' },
      { text: 'About', url: 'https://example.com/about' },
    ]);
  });

  it('returns null metadata and empty collections for a page without metadata', () => {
    expect(extract('<body><p>Only text</p></body>')).toMatchObject({
      title: null, description: null, language: null, headings: [], links: [], text: 'Only text',
    });
    expect(extract('<title>Not body text</title><body></body>').text).toBe('');
  });

  it('caps output and reports actual truncation', () => {
    const page = extract('<h1>One</h1><h2>Two</h2><a href="/one">1</a><a href="/one#x">dup</a><a href="/two">2</a>',
      { maxTextLength: 4, maxLinks: 1, maxHeadings: 1 });
    expect(page.text).toHaveLength(4);
    expect(page.headings).toHaveLength(1);
    expect(page.links).toHaveLength(1);
    expect(page).toMatchObject({ textTruncated: true, linksTruncated: true, headingsTruncated: true });
  });
});
