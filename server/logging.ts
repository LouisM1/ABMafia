type Options = { enabled: () => boolean; secrets: () => string[]; write: (text: string) => void };
const credentials = /^(authorization|cookie|setcookie|apikey|openaikey|openaiapikey|token|accesstoken|refreshtoken|session|password|secret)$/i;

export function createLogger(options: Options) {
  return (label: string, details: unknown = {}) => {
    if (!options.enabled()) return;
    // Logging must never interrupt game processing, even if the output pipe closes.
    try {
      const secrets = options.secrets().filter(Boolean);
      function clean(value: unknown, key = ''): unknown {
        if (credentials.test(key.replace(/[-_]/g, ''))) return '[REDACTED]';
        if (value instanceof Error) return clean({ name: value.name, message: value.message, stack: value.stack });
        if (typeof value === 'string') {
          let text = value;
          for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
          return text.replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
            .replace(/\bBearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]')
            .replace(/abmafia_session=[a-f0-9]+/gi, 'abmafia_session=[REDACTED]');
        }
        if (Array.isArray(value)) return value.map(item => clean(item));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
        return value;
      }
      options.write(`[${new Date().toISOString()}] ${label}\n${JSON.stringify(clean(details), null, 2)}\n\n`);
    } catch { /* Diagnostics must not alter game outcomes. */ }
  };
}
export const debugEnabled = () => /^(true|1)$/i.test(process.env.DEBUG_AI || '');
export const debugLog = createLogger({
  enabled: debugEnabled,
  secrets: () => [process.env.OPENAI_API_KEY?.trim() || ''],
  write: text => { process.stdout.write(text); },
});
