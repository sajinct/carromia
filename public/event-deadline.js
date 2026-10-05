// Registration closes at the configured time in India, regardless of a visitor's timezone.
export const defaultDeadlineTime = '21:00';
export const deadlineTime = event => event.registrationDeadlineTime ?? defaultDeadlineTime;
export const registrationCutoff = event => event.registrationDeadline
  ? Date.parse(`${event.registrationDeadline}T${deadlineTime(event)}:00+05:30`)
  : null;
export function registrationDeadlineText(event, options = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) {
  if (!event.registrationDeadline) return '';
  const date = new Date(`${event.registrationDeadline}T12:00:00Z`).toLocaleDateString('en-IN', { ...options, timeZone: 'Asia/Kolkata' });
  const time = new Date(registrationCutoff(event)).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  return `${date} at ${time} IST`;
}
