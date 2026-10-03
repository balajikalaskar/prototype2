// Match Crawlee's CommonJS Cheerio types (the package has separate ESM declarations).
import type { CheerioAPI } from 'cheerio' with { 'resolution-mode': 'require' };
import type { ExtractionLimits, PageContent } from '../types/crawler.types.js';
import { nullableText, normalizeText } from '../utils/text.js';
import { resolveLink } from '../utils/url.js';

export function extractPage($: CheerioAPI, finalUrl: string, limits: ExtractionLimits): PageContent {
  const title = nullableText($('title').first().text());
  const description = nullableText($('meta[name="description" i]').first().attr('content'));
  const language = nullableText($('html').attr('lang') ?? $('html').attr('xml:lang'));
  let baseUrl = finalUrl;
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) baseUrl = resolveLink(baseHref, finalUrl) ?? finalUrl;

  $('script, style, template, noscript, svg, canvas, iframe, [hidden]').remove();
  const headings: PageContent['headings'] = [];
  const links: PageContent['links'] = [];
  const seenLinks = new Set<string>();
  let headingsTruncated = false;
  let linksTruncated = false;

  $('h1, h2, h3, h4, h5, h6, a[href]').each((_index, node) => {
    const element = $(node);
    const text = normalizeText(element.text());
    if (node.tagName === 'a') {
      const url = resolveLink(element.attr('href') ?? '', baseUrl);
      if (!url || seenLinks.has(url)) return;
      if (links.length === limits.maxLinks) { linksTruncated = true; return; }
      seenLinks.add(url);
      links.push({ text: text.slice(0, 500), url });
    } else if (text) {
      if (headings.length === limits.maxHeadings) { headingsTruncated = true; return; }
      headings.push({ level: Number(node.tagName.slice(1)), text: text.slice(0, 1000) });
    }
  });

  // Insert separators at block boundaries so <p>one</p><p>two</p> does not become "onetwo".
  $('p, div, section, article, header, footer, nav, main, aside, li, tr, td, th, h1, h2, h3, h4, h5, h6, br, hr')
    .prepend(' ').append(' ');
  const body = $('body');
  const text = normalizeText(body.length ? body.text() : $.root().text());
  return {
    title: title?.slice(0, 1000) ?? null,
    description: description?.slice(0, 2000) ?? null,
    language: language?.slice(0, 100) ?? null,
    headings, links, text: text.slice(0, limits.maxTextLength),
    textTruncated: text.length > limits.maxTextLength,
    linksTruncated, headingsTruncated,
  };
}
