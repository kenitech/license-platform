// node:sqlite is built into Node.js 22.13+, so the server needs no npm
// packages. Node still prints an "experimental" warning when it loads; it
// is noise in the journal, so it is filtered here and nowhere else.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function filteredEmitWarning(warning, ...rest) {
  const text = typeof warning === 'string' ? warning : warning?.message || '';
  if (/SQLite is an experimental feature/.test(text)) return;
  return originalEmitWarning.call(process, warning, ...rest);
};

const { DatabaseSync } = await import('node:sqlite');

process.emitWarning = originalEmitWarning;

export { DatabaseSync };
