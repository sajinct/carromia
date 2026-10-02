import { analyticsConfig } from './analytics-config.js';

const ga4Id = /^G-[A-Z0-9]+$/.test(analyticsConfig.ga4MeasurementId) ? analyticsConfig.ga4MeasurementId : '';
const clarityId = /^[a-z0-9]+$/i.test(analyticsConfig.clarityProjectId) ? analyticsConfig.clarityProjectId : '';
const preferenceKey = 'carromia-analytics-consent-v1';
const publicPages = new Map([
  ['/', 'Home'], ['/rules', 'Rules'], ['/register', 'Registration'],
  ['/teams', 'Teams'], ['/results', 'Results'], ['/live', 'Live boards']
]);
const eventNames = new Set(['registration_complete', 'registration_form_download']);
// Preserve previous opt-outs. New visitors receive cookieless measurement automatically.
let optedOut = false; try { optedOut = localStorage.getItem(preferenceKey) === 'denied'; } catch {}
let context, lastPage, previousLocation = '', ga4Started = false, clarityStarted = false, clarityStopped = false;

export function analyticsEnabled() { return Boolean(ga4Id || clarityId); }
export function analyticsPreferenceLabel() { return optedOut ? 'Enable visitor analytics' : 'Disable visitor analytics'; }

function eligible() {
  return analyticsEnabled() && context && publicPages.has(context.page) && !context.state.isAdmin && !context.state.practice
    && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

function cleanLocation() {
  // Virtual paths make hash routes show as separate pages in GA4 reports.
  const base = context.pagesMode ? location.pathname.replace(/\/$/, '') : '';
  return `${location.origin}${base}${context.page}`;
}

function cleanReferrer(value) {
  try { const url = new URL(value); return url.origin === location.origin ? '' : `${url.origin}/`; } catch { return ''; }
}

function script(src) {
  const tag = document.createElement('script'); tag.async = true; tag.src = src;
  document.head.append(tag);
}

// Stop replay before the app renders private data or changes to a URL containing a QR token.
// Once stopped, Clarity stays off until a full page reload; public GA4 pageviews can resume.
function stopReplay() {
  if (!clarityStarted || clarityStopped) return;
  window.clarity('stop'); clarityStopped = true;
}

function suspend() {
  if (ga4Started) window[`ga-disable-${ga4Id}`] = true;
  stopReplay(); lastPage = undefined;
}

export function beforeAnalyticsNavigation(path) {
  if (!publicPages.has(path.split('?')[0]) || path.includes('?')) suspend();
}

function start() {
  if (optedOut || !eligible()) return;
  if (ga4Id) {
    window[`ga-disable-${ga4Id}`] = false;
    if (!ga4Started) {
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
      // No analytics cookies, advertising identifiers or inferred consent.
      window.gtag('consent', 'default', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
      window.gtag('js', new Date());
      window.gtag('config', ga4Id, {
        send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false,
        page_location: cleanLocation(), page_referrer: cleanReferrer(document.referrer)
      });
      ga4Started = true;
      script(`https://www.googletagmanager.com/gtag/js?id=${ga4Id}`);
    }
  }
  // Clarity reads the actual address. Skip deep links with query parameters entirely.
  if (clarityId && !clarityStarted && !location.search && !location.hash.includes('?')) {
    window.clarity = window.clarity || function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
    window.clarity('consentv2', { analytics_Storage: 'denied', ad_Storage: 'denied' });
    clarityStarted = true;
    script(`https://www.clarity.ms/tag/${clarityId}`);
  }
}

function trackPage() {
  start();
  if (optedOut || !eligible() || lastPage === context.page) return;
  const url = cleanLocation();
  if (ga4Started) {
    const fields = { page_location: url, page_title: `CARROMIA · ${publicPages.get(context.page)}`, page_referrer: previousLocation || cleanReferrer(document.referrer) };
    window.gtag('set', fields);
    window.gtag('event', 'page_view', { ...fields, send_to: ga4Id });
  }
  lastPage = context.page; previousLocation = url;
}

export function toggleAnalytics() {
  optedOut = !optedOut;
  try { localStorage.setItem(preferenceKey, optedOut ? 'denied' : 'granted'); } catch {}
  if (optedOut) suspend(); else trackPage();
  return analyticsPreferenceLabel();
}

export function updateAnalytics(page, state, pagesMode) {
  context = { page, state, pagesMode };
  if (!eligible()) suspend();
  if (location.search || location.hash.includes('?')) stopReplay();
  trackPage();
}

export function trackAnalyticsEvent(name) {
  if (optedOut || !eligible() || !eventNames.has(name)) return;
  // No form fields, team identifiers, payment references, photos or QR tokens.
  if (ga4Started) window.gtag('event', name, { send_to: ga4Id, page_location: cleanLocation() });
  if (clarityStarted && !clarityStopped) window.clarity('event', name);
}
