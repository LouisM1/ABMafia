let enabled = false;
let installed = false;
let count = 0;
let windowStart = 0;

export function reportClient(event: string, details: unknown = {}) {
  if (!enabled) return;
  if (Date.now() - windowStart > 10_000) { count = 0; windowStart = Date.now(); }
  if (++count > 10) return;
  try {
    const message = JSON.stringify(details, (_key, value) => value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack } : value).slice(0, 4000);
    // Deliberately uses fetch directly, so a logging failure cannot report itself.
    void fetch('/api/client-log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, message }), keepalive: true,
    }).catch(() => {});
  } catch { /* Browser diagnostics are best-effort when the server is unreachable. */ }
}
export function enableClientDebug(value: boolean) {
  enabled = value;
  if (!enabled || installed) return;
  installed = true;
  window.addEventListener('error', event => reportClient('runtime-error', { error: event.error || event.message }));
  window.addEventListener('unhandledrejection', event => reportClient('unhandled-rejection', { error: event.reason }));
  reportClient('ready', { message: 'Browser diagnostics connected to the terminal.' });
}
