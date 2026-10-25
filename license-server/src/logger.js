const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// One JSON object per line, which journald stores as-is.
export function createLogger(minLevel = 'info', stream = process.stdout) {
  const min = LEVELS[minLevel] ?? LEVELS.info;
  return function log(level, msg, fields = {}) {
    if ((LEVELS[level] ?? LEVELS.info) < min) return;
    stream.write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }) + '\n');
  };
}
