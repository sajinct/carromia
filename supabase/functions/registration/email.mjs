// Shared by the live Edge Function and the Node server. Keys never reach the browser.
export function registrationEmailConfig(read) {
  return {
    apiKey: read('RESEND_API_KEY'), from: read('REGISTRATION_EMAIL_FROM'),
    publicUrl: read('PUBLIC_URL') || 'https://carromia.marymathachurchvijayanagar.com'
  };
}

// One notice per saved submission, including a group registration. Participant details stay
// in the signed-in desk: the email contains only a count, payment reminder and desk link.
export async function sendRegistrationEmail(teams, event, alerts, config = {}, fetchImpl = fetch, report = console.error, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  if (event !== 'main' || !teams?.length || !alerts?.enabled) return { status: 'skipped' };
  try {
    const recipients = [...new Set((alerts.recipients || []).map(address => String(address).trim().toLowerCase()))];
    if (!recipients.length || recipients.length > 10 || recipients.some(address => address.length > 254 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(address))) throw new Error('Invalid recipients');
    if (!config.apiKey || !config.from) {
      report('Registration email not sent: set RESEND_API_KEY and REGISTRATION_EMAIL_FROM in the server secrets.');
      return { status: 'failed' };
    }
    const desk = new URL(config.publicUrl || 'https://carromia.marymathachurchvijayanagar.com');
    if (!['https:', 'http:'].includes(desk.protocol)) throw new Error('Invalid site URL');
    desk.search = ''; desk.hash = '/admin/teams';
    const pending = teams.filter(team => team.status === 'pending').length;
    const body = JSON.stringify({ from: config.from, to: recipients,
      subject: teams.length === 1 ? 'CARROMIA: new team registration' : `CARROMIA: ${teams.length} new team registrations`,
      text: [
        `${teams.length === 1 ? 'A team has' : `${teams.length} teams have`} completed the registration form.`,
        ...(pending ? [`${pending} ${pending === 1 ? 'team needs' : 'teams need'} payment verification at the desk.`] : []),
        '', `Open Teams: ${desk.href}`, 'Sign in to review the registration details.'
      ].join('\n')
    });
    // Team IDs may be reused after a reset; include the saved registration time.
    const identity = teams.map(team => `${team.id}:${team.registeredAt}`).join('|');
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)));
    const key = 'carromia-registration-' + Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
    for (let attempt = 0; attempt < 3; attempt++) {
      let retryDelay = 500 * (attempt + 1);
      try {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
          body, signal: AbortSignal.timeout(5000)
        });
        await res.text(); // Consume within the timeout, without logging provider/participant data.
        if (res.ok) return { status: 'sent' };
        if (res.status !== 429 && res.status < 500) {
          report(`Registration email not sent: Resend returned HTTP ${res.status}. Check the email configuration.`);
          return { status: 'failed' };
        }
        const retryAfter = Number(res.headers.get('Retry-After'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) retryDelay = Math.min(10000, retryAfter * 1000);
      } catch { /* Temporary network failure: retry with the same idempotency key. */ }
      if (attempt < 2) await pause(retryDelay);
    }
    report('Registration email not sent after 3 attempts. Check Resend and the function logs.');
  } catch {
    report('Registration email not sent: check the email configuration.');
  }
  // Alert failures never undo a saved registration or remove its uploaded files.
  return { status: 'failed' };
}
