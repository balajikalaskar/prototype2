import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { NormalizedOptions } from 'got-scraping';
import { CrawlError } from '../services/crawl-error.js';

export function parseHttpUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new CrawlError('INVALID_URL', 'A valid absolute URL is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new CrawlError('INVALID_URL', 'Only HTTP/HTTPS URLs without credentials are supported.');
  }
  return url;
}

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; }
  catch { return false; }
}

/** Validate and pin the socket lookup to the same addresses; a second DNS query cannot rebind it. */
export async function secureDestination(
  options: Pick<NormalizedOptions, 'url' | 'dnsCache' | 'dnsLookup'>,
  signal: AbortSignal,
): Promise<void> {
  const url = parseHttpUrl(String(options.url));
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await resolvePublicDestination(url.href, signal);
  const pinnedLookup: LookupFunction = (requestedHost, lookupOptions, callback) => {
    if (requestedHost.replace(/^\[|\]$/g, '').toLowerCase() !== hostname.toLowerCase()) {
      callback(new CrawlError('DISALLOWED_DESTINATION', 'Unexpected destination lookup.'), '');
      return;
    }
    const matching = addresses.filter(({ family }) => !lookupOptions.family || family === lookupOptions.family);
    const first = matching[0];
    if (!first) { callback(new Error('No address for the requested IP family.'), ''); return; }
    if (lookupOptions.all) callback(null, matching);
    else callback(null, first.address, first.family);
  };
  options.dnsCache = undefined;
  options.dnsLookup = pinnedLookup;
}

export async function resolvePublicDestination(value: string, signal: AbortSignal): Promise<LookupAddress[]> {
  signal.throwIfAborted();
  const url = parseHttpUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname.toLowerCase().replace(/\.$/, '') === 'localhost') {
    throw new CrawlError('DISALLOWED_DESTINATION', 'Local and non-public destinations are not allowed.');
  }
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await new Promise<LookupAddress[]>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      lookup(hostname, { all: true, order: 'ipv4first' })
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new CrawlError('DISALLOWED_DESTINATION', 'Local and non-public destinations are not allowed.');
  }
  return addresses;
}

export function resolveLink(href: string, baseUrl: string): string | null {
  if (!href.trim() || href.trim().startsWith('#')) return null;
  try {
    const url = parseHttpUrl(new URL(href, baseUrl).href);
    url.hash = '';
    return url.href;
  } catch { return null; }
}
