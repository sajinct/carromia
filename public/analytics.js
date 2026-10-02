import { analyticsConfig } from './analytics-config.js';

const ga4Id = /^G-[A-Z0-9]+$/.test(analyticsConfig.ga4MeasurementId) ? analyticsConfig.ga4MeasurementId : '';
const clarityId = /^[a-z0-9]+$/i.test(analyticsConfig.clarityProjectId) ? analyticsConfig.clarityProjectId : '';
const preferenceKey = 'carromia-analytics-consent-v1';
const publicPages = new Map([
  ['/', 'Home'], ['/rules', 'Rules'], ['/register', 'Registration'],
  ['/teams', 'Teams'], ['/results', 'Results'], ['/live', 'Live boards']
]);
const eventNames = new Set(['registration_complete', 'registration_form_download']);
let consent; try { consent = localStorage.getItem(preferenceKey); } catch {}
let context, lastPage, previousLocation = '', ga4Started = false, clarityStarted = false, clarityStopped = false, panel;

export function analyticsEnabled() { return Boolean(ga4Id || clarityId); }

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
  if (consent !== 'granted' || !eligible()) return;
  if (ga4Id) {
    window[`ga-disable-${ga4Id}`] = false;
    if (!ga4Started) {
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
      window.gtag('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
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
    window.clarity('consentv2', { analytics_Storage: 'granted', ad_Storage: 'denied' });
    clarityStarted = true;
    script(`https://www.clarity.ms/tag/${clarityId}`);
  }
}

function trackPage() {
  start();
  if (consent !== 'granted' || !eligible() || lastPage === context.page) return;
  const url = cleanLocation();
  if (ga4Started) {
    const fields = { page_location: url, page_title: `CARROMIA · ${publicPages.get(context.page)}`, page_referrer: previousLocation || cleanReferrer(document.referrer) };
    window.gtag('set', fields);
    window.gtag('event', 'page_view', { ...fields, send_to: ga4Id });
  }
  lastPage = context.page; previousLocation = url;
}

function showPreferences(expanded = false) {
  if (!panel) {
    panel = document.createElement('aside'); panel.className = 'analytics-consent';
    panel.setAttribute('aria-label', 'Visitor analytics preferences');
    document.body.append(panel);
  }
  panel.hidden = !eligible() || (!expanded && Boolean(consent));
  if (panel.hidden) return;
  panel.innerHTML = '<strong>Allow visitor analytics?</strong><p>Google Analytics measures visits and registrations. Microsoft Clarity shows clicks and scrolling to help us improve the site. These tools use cookies. Registration details are masked in replays. You can change your choice using Analytics preferences in the footer.</p><div><button type="button" class="btn outline small" data-analytics-choice="denied">Decline</button><button type="button" class="btn primary small" data-analytics-choice="granted">Allow analytics</button></div>';
  panel.querySelectorAll('[data-analytics-choice]').forEach(button => button.addEventListener('click', () => {
    consent = button.dataset.analyticsChoice;
    try { localStorage.setItem(preferenceKey, consent); } catch {}
    panel.hidden = true;
    if (consent === 'granted') {
      if (ga4Started) window.gtag('consent', 'update', { analytics_storage: 'granted' });
      trackPage();
    } else {
      if (ga4Started) window.gtag('consent', 'update', { analytics_storage: 'denied' });
      if (clarityStarted) window.clarity('consentv2', { analytics_Storage: 'denied', ad_Storage: 'denied' });
      suspend();
    }
  }));
}

document.addEventListener('click', event => {
  if (event.target.closest('[data-analytics-settings]')) showPreferences(true);
});

export function updateAnalytics(page, state, pagesMode) {
  context = { page, state, pagesMode };
  if (!eligible()) suspend();
  if (location.search || location.hash.includes('?')) stopReplay();
  showPreferences(); trackPage();
}

export function trackAnalyticsEvent(name) {
  if (consent !== 'granted' || !eligible() || !eventNames.has(name)) return;
  // No form fields, team identifiers, payment references, photos or QR tokens.
  if (ga4Started) window.gtag('event', name, { send_to: ga4Id, page_location: cleanLocation() });
  if (clarityStarted && !clarityStopped) window.clarity('event', name);
}
