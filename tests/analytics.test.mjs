import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/analytics.js', import.meta.url), 'utf8')
  .replace("import { analyticsConfig } from './analytics-config.js';", '')
  .replaceAll('export function ', 'function ');

function browser({ consent = null, hash = '#/', search = '', hostname = 'sajinct.github.io', pathname = '/carromia/', config } = {}) {
  const scripts = [], panels = [], handlers = {}, stored = new Map();
  if (consent) stored.set('carromia-analytics-consent-v1', consent);
  const document = {
    referrer: 'https://example.org/campaign?email=private@example.org#secret',
    head: { append: tag => scripts.push(tag.src) }, body: { append: el => panels.push(el) },
    addEventListener: (name, fn) => { handlers[name] = fn; },
    createElement: tag => {
      if (tag === 'script') return {};
      const buttons = ['denied', 'granted'].map(choice => ({ dataset: { analyticsChoice: choice }, addEventListener: (_, fn) => { buttons.find(b => b.dataset.analyticsChoice === choice).click = fn; } }));
      return { hidden: false, setAttribute() {}, querySelectorAll: () => buttons, buttons };
    }
  };
  const window = {};
  const location = { origin: `https://${hostname}`, hostname, pathname, search, hash };
  const env = { window, document, location, URL, analyticsConfig: config || { ga4MeasurementId: 'G-TEST123', clarityProjectId: 'test123' },
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) } };
  const api = runInNewContext(`${source}\n({ updateAnalytics, trackAnalyticsEvent, beforeAnalyticsNavigation });`, env);
  return { ...api, window, location, scripts, panels, handlers, stored,
    update(page = '/', state = {}) { api.updateAnalytics(page, state, true); },
    choose(choice) { panels.at(-1).buttons.find(b => b.dataset.analyticsChoice === choice).click(); },
    events() { return Array.from(window.dataLayer || [], args => Array.from(args)); } };
}

test('unconfigured analytics and visitors without consent send no requests', () => {
  const disabled = browser({ consent: 'granted', config: { ga4MeasurementId: '', clarityProjectId: '' } });
  disabled.update(); assert.deepEqual(disabled.scripts, []); assert.equal(disabled.panels[0].hidden, true);
  const visitor = browser(); visitor.update();
  assert.deepEqual(visitor.scripts, []); assert.equal(visitor.panels[0].hidden, false);
  visitor.choose('denied'); visitor.update('/rules');
  assert.deepEqual(visitor.scripts, []); assert.equal(visitor.panels[0].hidden, true);
});

test('opt-in loads each provider once and real navigation sends distinct pageviews', () => {
  const visitor = browser(); visitor.update(); visitor.choose('granted');
  visitor.update(); visitor.update('/rules'); visitor.update('/rules'); visitor.update('/');
  assert.deepEqual(visitor.scripts, ['https://www.googletagmanager.com/gtag/js?id=G-TEST123', 'https://www.clarity.ms/tag/test123']);
  const views = visitor.events().filter(([command, name]) => command === 'event' && name === 'page_view');
  assert.deepEqual(views.map(([, , fields]) => fields.page_location), ['https://sajinct.github.io/carromia/', 'https://sajinct.github.io/carromia/rules', 'https://sajinct.github.io/carromia/']);
  assert.equal(visitor.events().find(([command]) => command === 'config')[2].send_page_view, false);
  assert.equal(views[0][2].page_referrer, 'https://example.org/');
});

test('private screens, practice, officials and local previews never initialize tracking', () => {
  for (const [page, state, hostname] of [['/admin', {}, 'sajinct.github.io'], ['/admin/teams', {}, 'sajinct.github.io'], ['/checkin', {}, 'sajinct.github.io'], ['/lunch', {}, 'sajinct.github.io'], ['/', { practice: true }, 'sajinct.github.io'], ['/', { isAdmin: true }, 'sajinct.github.io'], ['/', {}, 'localhost'], ['/', {}, '127.0.0.1']]) {
    const visitor = browser({ consent: 'granted', hostname }); visitor.update(page, state);
    visitor.trackAnalyticsEvent('registration_complete');
    assert.deepEqual(visitor.scripts, []); assert.deepEqual(visitor.events(), []);
  }
});

test('custom-domain pageviews use root paths for each public screen', () => {
  const visitor = browser({ consent: 'granted', hostname: 'carromia.marymathachurchvijayanagar.com', pathname: '/' });
  visitor.update(); visitor.update('/register');
  const views = visitor.events().filter(([command, name]) => command === 'event' && name === 'page_view');
  assert.deepEqual(views.map(([, , fields]) => fields.page_location), ['https://carromia.marymathachurchvijayanagar.com/', 'https://carromia.marymathachurchvijayanagar.com/register']);
});

test('deep links are sanitized for GA4 and excluded from Clarity', () => {
  const visitor = browser({ consent: 'granted', hash: '#/teams?team=PRIVATE-TEAM&mobile=9999999999', search: '?token=secret' });
  visitor.update('/teams'); visitor.trackAnalyticsEvent('registration_form_download');
  assert.deepEqual(visitor.scripts, ['https://www.googletagmanager.com/gtag/js?id=G-TEST123']);
  const payload = JSON.stringify(visitor.events());
  for (const sensitive of ['PRIVATE-TEAM', '9999999999', 'token', 'secret', 'private@example.org']) assert.ok(!payload.includes(sensitive));
  assert.ok(payload.includes('https://sajinct.github.io/carromia/teams'));
});

test('private navigation stops replay before routing and suppresses later events', () => {
  const visitor = browser({ consent: 'granted' }); visitor.update();
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

test('revoking consent disables providers immediately and persists the choice', () => {
  const visitor = browser({ consent: 'granted' }); visitor.update();
  visitor.handlers.click({ target: { closest: () => ({}) } }); visitor.choose('denied');
  const before = visitor.events().length;
  visitor.update('/register'); visitor.trackAnalyticsEvent('registration_complete');
  assert.equal(visitor.events().length, before);
  assert.equal(visitor.window['ga-disable-G-TEST123'], true);
  assert.equal(visitor.window.clarity.q.at(-1)[0], 'stop');
  assert.equal(visitor.stored.get('carromia-analytics-consent-v1'), 'denied');
});

test('only approved conversion events are sent without participant fields', () => {
  const visitor = browser({ consent: 'granted' }); visitor.update('/register');
  visitor.trackAnalyticsEvent('registration_complete'); visitor.trackAnalyticsEvent('registration_form_download');
  visitor.trackAnalyticsEvent('private-player-name');
  const events = visitor.events().filter(([command, name]) => command === 'event' && name !== 'page_view');
  assert.deepEqual(events.map(([, name]) => name), ['registration_complete', 'registration_form_download']);
  assert.deepEqual(Object.keys(events[0][2]).sort(), ['page_location', 'send_to']);
  assert.equal(visitor.window.clarity.q.at(-1)[1], 'registration_form_download');
});
