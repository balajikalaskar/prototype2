import { normalizeText } from '../../utils/text.js';
import { cheerio } from './helpers.js';
import type { Assessment, RetrievedPage } from './types.js';

export function classifyResponse(page: RetrievedPage): Assessment {
  const header = (name: string) => String(page.headers[name] ?? '').toLowerCase();
  if (page.upstreamStatus === 429) {
    const retry = header('retry-after');
    const seconds = Number(retry);
    const retryAfterMs = retry ? Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now()) : undefined;
    return { kind: 'RATE_LIMITED', retryAfterMs: retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : undefined };
  }
  const $ = page.parsed ?? cheerio.load(page.html);
  page.parsed = $;
  const title = normalizeText($('title').first().text()).toLowerCase();
  const body = $('body').clone();
  body.find('script,style,template,noscript,svg,iframe,form,[hidden]').remove();
  const text = normalizeText(body.text());
  const mainText = normalizeText($('main,article').text());
  const gateTitle = /^(just a moment|attention required|verify (you|your)|security check|captcha|access denied|pardon our interruption|robot check)/.test(title);
  const captchaWidget = $('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],.g-recaptcha,.h-captcha,[data-captcha-gate]').length > 0;
  const captchaPrompt = /(?:verify (?:that )?you are (?:a )?human|complete (?:the |this )?captcha|solve (?:the |this )?captcha|not a robot)/i.test(text);
  const akamaiChallenge = /triggerInterstitialChallenge|\/_sec\/verify\?provider=interstitial|bm-verify/i.test(page.html);
  // A widget on a comment/contact form is not a gate around the page's article.
  if (captchaWidget && (gateTitle || (captchaPrompt && mainText.length < 80 && text.length < 1000))) {
    return { kind: 'CAPTCHA_REQUIRED' };
  }
  if (header('cf-mitigated') === 'challenge') return { kind: 'BROWSER_CHALLENGE', provider: 'cloudflare' };
  if (akamaiChallenge) return { kind: 'BROWSER_CHALLENGE', provider: 'akamai' };
  if (gateTitle && $('script[src*="/cdn-cgi/challenge-platform"],#challenge-running,#challenge-form').length) {
    return { kind: 'BROWSER_CHALLENGE', provider: 'cloudflare' };
  }
  if (gateTitle && $('script[src*="captcha-delivery.com"],iframe[src*="captcha-delivery.com"]').length) {
    return { kind: 'BROWSER_CHALLENGE', provider: 'datadome' };
  }
  if ($('form input[type="password"]').length && mainText.length < 80
    && (/^(sign in|log in|login)/.test(title) || page.upstreamStatus === 401)) return { kind: 'LOGIN_REQUIRED' };
  if ([403, 503].includes(page.upstreamStatus) || gateTitle && text.length < 1000) return { kind: 'BOT_BLOCKED' };
  if (page.upstreamStatus < 200 || page.upstreamStatus >= 300) return { kind: 'UPSTREAM_ERROR' };
  // A successful status is not sufficient: bot defenses and JavaScript shells can
  // return an empty document. Never let extraction turn that into a false success.
  if (text.length === 0 && mainText.length === 0) return { kind: 'JAVASCRIPT_REQUIRED' };
  if ((text.length === 0 || /^(loading[.! ]*|please enable javascript[.! ]*)$/i.test(text))
    && $('script[src],#root,#app,#__next').length) return { kind: 'JAVASCRIPT_REQUIRED' };
  return { kind: 'USABLE_CONTENT' };
}
