import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/analytics.js', import.meta.url), 'utf8')
  .replace("import { analyticsConfig } from './analytics-config.js';", '')
  .replaceAll('export function ', 'function ');

function browser({ consent = null, cookieConsent = null, hash = '#/', search = '', hostname = 'sajinct.github.io', pathname = '/carromia/', config } = {}) {
  const scripts = [], panels = [], handlers = {}, stored = new Map();
  if (consent) stored.set('carromia-analytics-consent-v1', consent);
  if (cookieConsent) stored.set('carromia-analytics-cookie-consent-v2', cookieConsent);
  const document = {
    referrer: 'https://example.org/campaign?email=private@example.org#secret',
    head: { append: tag => scripts.push(tag.src) }, body: { append: el => panels.push(el) },
    addEventListener: (name, fn) => { handlers[name] = fn; },
    createElement: tag => {
      if (tag === 'script') return {};
      return { setAttribute() {} };
    }
  };
  const window = {};
  const location = { origin: `https://${hostname}`, hostname, pathname, search, hash };
  const env = { window, document, location, URL, analyticsConfig: config || { ga4MeasurementId: 'G-TEST123', clarityProjectId: 'test123' },
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) } };
  const api = runInNewContext(`${source}\n({ updateAnalytics, trackAnalyticsEvent, beforeAnalyticsNavigation, analyticsPreference, setAnalyticsPreference });`, env);
  return { ...api, window, location, scripts, panels, handlers, stored,
    update(page = '/', state = {}) { api.updateAnalytics(page, state, true); },
    events() { return Array.from(window.dataLayer || [], args => Array.from(args)); } };
}

test('unconfigured analytics and previous opt-outs send no requests or popups', () => {
  const disabled = browser({ consent: 'granted', config: { ga4MeasurementId: '', clarityProjectId: '' } });
  disabled.update(); assert.deepEqual(disabled.scripts, []); assert.equal(disabled.panels.length, 0);
  const visitor = browser({ consent: 'denied' }); visitor.update(); visitor.update('/rules');
  visitor.trackAnalyticsEvent('registration_complete');
  assert.deepEqual(visitor.scripts, []); assert.equal(visitor.panels.length, 0); assert.deepEqual(visitor.events(), []);
});

test('public visits load each provider automatically without cookies or a popup', () => {
  const visitor = browser(); visitor.update();
  visitor.update(); visitor.update('/rules'); visitor.update('/rules'); visitor.update('/');
  assert.deepEqual(visitor.scripts, ['https://www.googletagmanager.com/gtag/js?id=G-TEST123', 'https://www.clarity.ms/tag/test123']);
  const views = visitor.events().filter(([command, name]) => command === 'event' && name === 'page_view');
  assert.deepEqual(views.map(([, , fields]) => fields.page_location), ['https://sajinct.github.io/carromia/', 'https://sajinct.github.io/carromia/rules', 'https://sajinct.github.io/carromia/']);
  assert.equal(visitor.events().find(([command]) => command === 'config')[2].send_page_view, false);
  assert.equal(views[0][2].page_referrer, 'https://example.org/');
  assert.equal(visitor.panels.length, 0);
  const defaults = visitor.events()[0];
  assert.equal(defaults[0], 'consent'); assert.equal(defaults[1], 'default');
  assert.deepEqual(Object.values(defaults[2]), ['denied', 'denied', 'denied', 'denied']);
  assert.equal(visitor.window.clarity.q[0][0], 'consentv2');
  assert.deepEqual(Object.values(visitor.window.clarity.q[0][1]), ['denied', 'denied']);
});

test('private screens, practice, officials and local previews never initialize tracking', () => {
  for (const [page, state, hostname] of [['/admin', {}, 'sajinct.github.io'], ['/admin/teams', {}, 'sajinct.github.io'], ['/checkin', {}, 'sajinct.github.io'], ['/lunch', {}, 'sajinct.github.io'], ['/', { practice: true }, 'sajinct.github.io'], ['/', { isAdmin: true }, 'sajinct.github.io'], ['/', {}, 'localhost'], ['/', {}, '127.0.0.1']]) {
    const visitor = browser({ cookieConsent: 'granted', hostname }); visitor.update(page, state);
    visitor.trackAnalyticsEvent('registration_complete');
    assert.deepEqual(visitor.scripts, []); assert.deepEqual(visitor.events(), []);
  }
});

test('custom-domain pageviews use root paths for each public screen', () => {
  const visitor = browser({ cookieConsent: 'granted', hostname: 'carromia.marymathachurchvijayanagar.com', pathname: '/' });
  visitor.update(); visitor.update('/register');
  const views = visitor.events().filter(([command, name]) => command === 'event' && name === 'page_view');
  assert.deepEqual(views.map(([, , fields]) => fields.page_location), ['https://carromia.marymathachurchvijayanagar.com/', 'https://carromia.marymathachurchvijayanagar.com/register']);
});

test('deep links are sanitized for GA4 and excluded from Clarity', () => {
  const visitor = browser({ cookieConsent: 'granted', hash: '#/teams?team=PRIVATE-TEAM&mobile=9999999999', search: '?token=secret' });
  visitor.update('/teams'); visitor.trackAnalyticsEvent('registration_form_download');
  assert.deepEqual(visitor.scripts, ['https://www.googletagmanager.com/gtag/js?id=G-TEST123']);
  const payload = JSON.stringify(visitor.events());
  for (const sensitive of ['PRIVATE-TEAM', '9999999999', 'token', 'secret', 'private@example.org']) assert.ok(!payload.includes(sensitive));
  assert.ok(payload.includes('https://sajinct.github.io/carromia/teams'));
});

test('private navigation stops replay before routing and suppresses later events', () => {
  const visitor = browser({ cookieConsent: 'granted' }); visitor.update();
  visitor.beforeAnalyticsNavigation('/checkin?token=secret');
  assert.equal(visitor.window['ga-disable-G-TEST123'], true);
  assert.equal(visitor.window.clarity.q.at(-1)[0], 'stop');
  visitor.update('/checkin'); visitor.trackAnalyticsEvent('registration_complete');
  assert.equal(visitor.events().filter(([command]) => command === 'event').length, 1);
  visitor.update('/rules');
  assert.equal(visitor.window['ga-disable-G-TEST123'], false);
  assert.equal(visitor.scripts.filter(src => src.includes('clarity.ms')).length, 1);
  visitor.trackAnalyticsEvent('registration_form_download');
  assert.equal(visitor.window.clarity.q.at(-1)[0], 'stop', 'stopped replay stays off until reload');
});

test('the footer opt-out disables providers immediately and persists the choice', () => {
  const visitor = browser(); visitor.update();
  visitor.setAnalyticsPreference('denied');
  assert.equal(visitor.analyticsPreference(), 'denied');
  const before = visitor.events().length;
  visitor.update('/register'); visitor.trackAnalyticsEvent('registration_complete');
  assert.equal(visitor.events().length, before);
  assert.equal(visitor.window['ga-disable-G-TEST123'], true);
  assert.equal(visitor.window.clarity.q.at(-1)[0], 'stop');
  assert.equal(visitor.stored.get('carromia-analytics-cookie-consent-v2'), 'denied');
  assert.equal(visitor.panels.length, 0);
});

test('allowing analytics cookies after an opt-out starts providers with explicit consent', () => {
  const visitor = browser({ consent: 'denied' }); visitor.update();
  visitor.setAnalyticsPreference('granted');
  assert.equal(visitor.analyticsPreference(), 'granted');
  assert.equal(visitor.scripts.length, 2);
  assert.deepEqual(Object.values(visitor.events()[0][2]), ['granted', 'denied', 'denied', 'denied']);
  assert.deepEqual(Object.values(visitor.window.clarity.q[0][1]), ['granted', 'denied']);
  assert.equal(visitor.stored.get('carromia-analytics-cookie-consent-v2'), 'granted');
  assert.equal(visitor.panels.length, 0);
  const restored = browser({ consent: 'denied', cookieConsent: 'granted' }); restored.update();
  assert.equal(restored.events()[0][2].analytics_storage, 'granted', 'explicit cookie choice survives reload and overrides older opt-out');
});

test('old enable choices cannot grant cookie consent and new opt-outs survive reload', () => {
  const previousConsent = browser({ consent: 'granted' }); previousConsent.update();
  assert.equal(previousConsent.events()[0][2].analytics_storage, 'denied', 'legacy permission does not enable cookies in the new mode');
  const optedOut = browser({ consent: 'granted', cookieConsent: 'denied' }); optedOut.update();
  assert.deepEqual(optedOut.scripts, []);
});

test('granting consent during a visit updates providers before a reportable pageview', () => {
  const visitor = browser(); visitor.update('/rules');
  const before = visitor.events().length;
  visitor.setAnalyticsPreference('granted');
  const added = visitor.events().slice(before);
  assert.equal(added[0][0], 'consent'); assert.equal(added[0][1], 'update');
  assert.deepEqual(Object.values(added[0][2]), ['granted', 'denied', 'denied', 'denied']);
  assert.equal(added.at(-1)[0], 'event'); assert.equal(added.at(-1)[1], 'page_view');
  assert.equal(added.at(-1)[2].page_location, 'https://sajinct.github.io/carromia/rules');
  assert.equal(visitor.window.clarity.q.at(-1)[0], 'consentv2');
  assert.deepEqual(Object.values(visitor.window.clarity.q.at(-1)[1]), ['granted', 'denied']);
  assert.equal(visitor.scripts.length, 2, 'consent update does not reload providers');
  visitor.setAnalyticsPreference('granted');
  assert.equal(visitor.events().length, before + added.length, 'repeated permission does not duplicate views');
});

test('revoking cookie permission updates consent then prevents further events', () => {
  const visitor = browser({ cookieConsent: 'granted' }); visitor.update();
  visitor.setAnalyticsPreference('denied');
  const update = visitor.events().at(-1);
  assert.equal(update[0], 'consent'); assert.equal(update[1], 'update');
  assert.deepEqual(Object.values(update[2]), ['denied', 'denied', 'denied', 'denied']);
  assert.equal(visitor.window.clarity.q.at(-2)[0], 'consentv2');
  assert.deepEqual(Object.values(visitor.window.clarity.q.at(-2)[1]), ['denied', 'denied']);
  assert.equal(visitor.window.clarity.q.at(-1)[0], 'stop');
  const before = visitor.events().length;
  visitor.update('/rules'); visitor.trackAnalyticsEvent('registration_complete');
  assert.equal(visitor.events().length, before);
  assert.equal(visitor.window['ga-disable-G-TEST123'], true);
});

test('cookie permission cannot start tracking on excluded screens', () => {
  const visitor = browser(); visitor.update('/admin', { isAdmin: true });
  visitor.setAnalyticsPreference('granted');
  assert.deepEqual(visitor.scripts, []); assert.deepEqual(visitor.events(), []);
});

test('only approved conversion events are sent without participant fields', () => {
  const visitor = browser({ cookieConsent: 'granted' }); visitor.update('/register');
  visitor.trackAnalyticsEvent('registration_complete'); visitor.trackAnalyticsEvent('registration_form_download');
  visitor.trackAnalyticsEvent('private-player-name');
  const events = visitor.events().filter(([command, name]) => command === 'event' && name !== 'page_view');
  assert.deepEqual(events.map(([, name]) => name), ['registration_complete', 'registration_form_download']);
  assert.deepEqual(Object.keys(events[0][2]).sort(), ['page_location', 'send_to']);
  assert.equal(visitor.window.clarity.q.at(-1)[1], 'registration_form_download');
});
