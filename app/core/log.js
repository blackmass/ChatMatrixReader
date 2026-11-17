// A tiny logger: the program sets `log.sink` to write into the log file; until then it prints to the console.
const out = (level, args) => {
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  if (log.sink) log.sink(level, msg); else if (!log.quiet) console.log(`[${level}] ${msg}`);
};
export const log = {
  sink: null, quiet: false,
  info: (...a) => out('info', a), warn: (...a) => out('warn', a), error: (...a) => out('error', a),
};
// Python's "%d / %s" formatting for the messages ported as they are
export function fmt(s, ...args) { let i = 0; return s.replace(/%[ds]/g, () => String(args[i++])); }
