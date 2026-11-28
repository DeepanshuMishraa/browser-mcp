// Bot-challenge and block-page detection after a navigation.
// - auto: an interstitial the browser clears by itself (Cloudflare "Just a moment…"); we wait for it, up to a bound.
// - interactive: a check only a person should answer; the agent is told to hand it to the user.
// - block: the site refused the visit; retrying makes it worse for the user's IP and account.
// Generic phrases only count on short pages, so an article that mentions them is not a challenge.
import { z } from 'zod';
import type { Tab } from './tab.ts';

export type ChallengeKind = 'auto' | 'interactive' | 'block';
export type Detection = { vendor: string; kind: ChallengeKind; signal: string };
export type ChallengeOutcome =
  /** An auto check that went away while we waited. */
  | { status: 'cleared'; detection: Detection; waitedMs: number }
  | { status: 'present'; detection: Detection; waitedMs: number };

const ProbeSchema = z.object({
  url: z.string(),
  title: z.string(),
  /** The first 2000 characters of the body text, lowercased by classify. */
  text: z.string(),
  textLength: z.number(),
  scriptSrcs: z.array(z.string()),
  /** Which of SELECTORS matched, and which of those have a visible box. */
  selectors: z.array(z.string()),
  visibleSelectors: z.array(z.string()),
});
export type Probe = z.infer<typeof ProbeSchema> & { frameUrls: string[] };

const SELECTORS = [
  '#challenge-form',
  '#challenge-running',
  '#challenge-stage',
  '#cf-challenge-running',
  '.cf-turnstile',
  '#cf-error-details',
  '#sec-if-cpt-container',
  '#sec-cpt-if',
  '#sec-text-if',
  '#ddv1-captcha-container',
  '#px-captcha',
  '#px-captcha-wrapper',
  "[id^='px-captcha']",
  "#main-iframe[src*='_Incapsula_Resource']",
  'awswaf-captcha',
  '#challenge-container',
] as const;

const PROBE = `(() => {
  const selectors = [], visibleSelectors = [];
  for (const s of ${JSON.stringify(SELECTORS)}) {
    const el = document.querySelector(s);
    if (!el) continue;
    selectors.push(s);
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) visibleSelectors.push(s);
  }
  const text = document.body ? document.body.innerText : '';
  return JSON.stringify({
    url: location.href, title: document.title, text: text.slice(0, 2000), textLength: text.length,
    scriptSrcs: [...document.scripts].map((s) => s.src).filter(Boolean).slice(0, 50), selectors, visibleSelectors,
  });
})()`;

const SHORT_PAGE_CHARS = 1500;

/** Classifies a probed page, or undefined when it doesn't look like a challenge or block page. */
export function classify(probe: Probe): Detection | undefined {
  const title = probe.title.trim().toLowerCase();
  const text = probe.text.toLowerCase();
  const short = probe.textLength < SHORT_PAGE_CHARS;
  const has = (s: string) => probe.selectors.includes(s);
  const visible = (s: string) => probe.visibleSelectors.includes(s);
  const frame = (re: RegExp) => probe.frameUrls.find((u) => re.test(u));
  const script = (re: RegExp) => probe.scriptSrcs.find((u) => re.test(u));
  const found = (vendor: string, kind: ChallengeKind, signal: string): Detection => ({ vendor, kind, signal: signal.slice(0, 160) });

  // Cloudflare
  if (text.includes('sorry, you have been blocked') && (has('#cf-error-details') || text.includes('cloudflare'))) {
    return found('cloudflare', 'block', 'text: Sorry, you have been blocked');
  }
  const interstitial =
    /^just a moment\b|^attention required! \| cloudflare|^checking your browser|^un instant|^einen moment/.test(title) ||
    ['#challenge-form', '#challenge-running', '#cf-challenge-running', '#challenge-stage'].some(has);
  const turnstile = frame(/^https:\/\/challenges\.cloudflare\.com\/.*(turnstile|challenge-platform)/);
  if (interstitial || (turnstile && short)) {
    const widget = visible('.cf-turnstile') || /verify you are human by completing|click to verify|confirm you are human/.test(text);
    return found('cloudflare', widget ? 'interactive' : 'auto', interstitial ? `title: ${probe.title.trim()}` : `iframe ${turnstile}`);
  }

  // PerimeterX / HUMAN
  if (has('#px-captcha') || has('#px-captcha-wrapper') || has("[id^='px-captcha']") || /press (?:&|and) hold/.test(text)) {
    return found('perimeterx', 'interactive', has('#px-captcha') ? 'element #px-captcha' : 'text: Press & Hold');
  }

  // DataDome
  const datadome = frame(/captcha-delivery\.com/);
  if (datadome || has('#ddv1-captcha-container')) {
    return found('datadome', datadome?.includes('/interstitial/') ? 'auto' : 'interactive', datadome ? `iframe ${datadome}` : 'element #ddv1-captcha-container');
  }

  // Akamai Bot Manager
  if (has('#sec-if-cpt-container') || has('#sec-cpt-if') || has('#sec-text-if')) {
    const interactive = visible('#sec-cpt-if') && /verify|press|slide|captcha/.test(text);
    return found('akamai', interactive ? 'interactive' : 'auto', 'element #sec-if-cpt-container');
  }
  if (title === 'access denied' && text.includes("you don't have permission to access") && /reference #?\d/.test(text)) {
    return found('akamai', 'block', 'title: Access Denied (Akamai reference)');
  }

  // Imperva / Incapsula
  const incapsula = frame(/_Incapsula_Resource/) ?? script(/_Incapsula_Resource/);
  if (incapsula || has("#main-iframe[src*='_Incapsula_Resource']")) {
    const captcha = /captcha|verify you are human|i am human/.test(text) || frame(/hcaptcha|recaptcha/) !== undefined;
    if (!captcha && /request unsuccessful|incapsula incident id/.test(text)) return found('imperva', 'block', 'text: Request unsuccessful (Incapsula)');
    return found('imperva', captcha ? 'interactive' : 'auto', `resource ${incapsula ?? '_Incapsula_Resource'}`);
  }
  if (short && text.includes('incapsula incident id')) return found('imperva', 'block', 'text: Incapsula incident ID');

  // AWS WAF
  if (has('awswaf-captcha')) return found('aws-waf', 'interactive', 'element awswaf-captcha');
  const awsScript = script(/\.awswaf\.com\//);
  if (awsScript && short && (has('#challenge-container') || probe.textLength < 300)) return found('aws-waf', 'auto', `script ${awsScript}`);

  if (!short) return undefined;

  // Captcha walls: a short page that puts a reCAPTCHA or hCaptcha widget between the user and the site.
  // The widget alone is not enough: sign-up forms and demo pages embed one, and "captcha" appears in their text.
  const wall =
    /verify you are (?:a )?human|are you a robot|not a robot|unusual traffic|security check|complete the captcha to continue|solve (?:the|this) captcha to continue/.test(text) ||
    /security check|are you a robot|human verification|verify you are human/.test(title);
  const hcaptcha = frame(/^https:\/\/(?:newassets\.|assets\.)?hcaptcha\.com\/captcha\//);
  if (hcaptcha && wall) return found('hcaptcha', 'interactive', `iframe ${hcaptcha}`);
  const recaptcha = frame(/^https:\/\/www\.(?:google|recaptcha)\.(?:com|net)\/recaptcha\/(?:api2|enterprise)\/anchor/);
  if (recaptcha && wall) return found('recaptcha', 'interactive', `iframe ${recaptcha}`);
  if (/^https:\/\/www\.google\.[a-z.]+\/sorry\//.test(probe.url)) return found('recaptcha', 'interactive', 'url: google.com/sorry');

  // Generic block and verification pages.
  if (/^(?:access denied|403 forbidden|forbidden|blocked|request blocked|you have been blocked)$/.test(title) || /^(?:access to this page has been denied|access denied)\b/.test(text.trim())) {
    return found('generic', 'block', `title: ${probe.title.trim() || text.trim().slice(0, 60)}`);
  }
  const both = `${title}\n${text}`;
  const verify = /verify (?:that )?you are (?:a )?human|confirm you are (?:a )?human|are you a robot\?|pardon our interruption|please verify you are a human|\bbot (?:check|detection)\b/.exec(both);
  if (verify) return found('generic', 'interactive', `text: ${verify[0]}`);
  return undefined;
}

/** How long to wait for an auto check to clear: MINI_BROWSER_CHALLENGE_WAIT_MS, 0 to 60000, default 15000. */
export function challengeWaitMs(value: string | undefined) {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 60_000 ? n : 15_000;
}

const WAIT_MS = challengeWaitMs(process.env.MINI_BROWSER_CHALLENGE_WAIT_MS);

type FrameTree = { frame: { url: string }; childFrames?: FrameTree[] };
const frameUrls = (t: FrameTree): string[] => [t.frame.url, ...(t.childFrames ?? []).flatMap(frameUrls)];

/** undefined = could not read the page (navigating); null = not a web page (about:, chrome:, file:). */
async function probe(tab: Tab): Promise<Probe | null | undefined> {
  try {
    const r = await tab.page.send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, 2000);
    const parsed = ProbeSchema.safeParse(JSON.parse(String(r.result.value)));
    if (!parsed.success) return undefined;
    if (!/^https?:/.test(parsed.data.url)) return null;
    // Cross-origin frames (Turnstile sits in a closed shadow root) are only visible through the frame trees.
    const trees = await Promise.all([tab.page, ...tab.oopifs.values()].map((s) => s.send('Page.getFrameTree', undefined, 1000).catch(() => undefined)));
    const urls = trees.flatMap((t) => (t ? frameUrls(t.frameTree) : []));
    return { ...parsed.data, frameUrls: [...new Set(urls)].slice(0, 50) };
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Classifies the page and waits out an auto check for up to `waitMs`. undefined when there is no challenge. */
export async function detectChallenge(tab: Tab, waitMs = WAIT_MS): Promise<ChallengeOutcome | undefined> {
  if (tab.dialog) return undefined;
  const first = await probe(tab);
  if (!first) return undefined;
  let detection = classify(first);
  if (!detection) return undefined;
  const start = performance.now();
  const waited = () => Math.round(performance.now() - start);
  while (detection.kind === 'auto' && performance.now() - start < waitMs) {
    await sleep(Math.min(1000, waitMs - (performance.now() - start)));
    const next = await probe(tab);
    // Mid-navigation: the check often clears by navigating, so keep waiting.
    if (next === undefined) continue;
    const again = next === null ? undefined : classify(next);
    if (!again) return { status: 'cleared', detection, waitedMs: waited() };
    detection = again;
  }
  return { status: 'present', detection, waitedMs: detection.kind === 'auto' ? waited() : 0 };
}

/** One line for the action report. */
export function describeChallenge(o: ChallengeOutcome, url: string) {
  const { vendor, kind, signal } = o.detection;
  const secs = Math.round(o.waitedMs / 1000);
  if (o.status === 'cleared') return `bot check: ${vendor} check cleared by itself after ${secs}s`;
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    // keep the raw URL
  }
  if (kind === 'block') {
    return `blocked: ${origin} refused the visit (${vendor}, ${signal}). Don't retry or reload; that makes the block worse for the user's IP and account. Stop and tell the user.`;
  }
  const still = kind === 'auto' ? `, still running after ${secs}s` : '';
  return `bot check: ${vendor} ${kind === 'auto' ? 'check' : 'challenge'} on ${origin} (${signal}${still}) needs a person. Don't reload or retry. Ask the user to complete it in this tab, then continue (wait_for the content you expect).`;
}
