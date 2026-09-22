import winston from 'winston';

const { combine, timestamp, printf, colorize, json, errors } = winston.format;

// Human-readable in dev (colorized, one line per entry); JSON in
// production, since that's what a real log aggregator (CloudWatch,
// Datadog, whatever ends up in front of this once it's actually
// deployed — see SNAPORDER_STATUS.md) expects to parse, not colored text
// meant for a terminal.
const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${ts} ${level}: ${message}${metaStr}`;
  })
);

const prodFormat = combine(timestamp(), errors({ stack: true }), json());

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
  transports: [new winston.transports.Console()],
  // Never let a logging failure crash the process — logging is a
  // side-effect of a request/operation, not something that should be
  // able to take the whole server down if e.g. stdout is somehow broken.
  exitOnError: false,
  // Winston's Console transport writes every level via console.log
  // internally, not console.error/warn — so a test file's
  // `jest.spyOn(console, 'error')` (used throughout tests/integration/
  // to silence expected-noise negative-path logging, e.g. an invalid
  // webhook signature) no longer catches it. Silencing entirely under
  // NODE_ENV=test (set by tests/.env.test) preserves that same intent
  // without touching every test file's spy setup.
  silent: process.env.NODE_ENV === 'test',
});
