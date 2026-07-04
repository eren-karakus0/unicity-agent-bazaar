/**
 * Tiny prefixed logger. Keeps agent output readable when several agents log
 * to the same terminal (each line is tagged with the agent name).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  constructor(
    private readonly prefix: string,
    private readonly minLevel: LogLevel = 'info',
  ) {}

  child(suffix: string): Logger {
    return new Logger(`${this.prefix}:${suffix}`, this.minLevel);
  }

  private log(level: LogLevel, msg: string, ...rest: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const ts = new Date().toISOString().slice(11, 19);
    const line = `${ts} [${this.prefix}] ${msg}`;
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(line, ...rest);
  }

  debug(msg: string, ...rest: unknown[]): void {
    this.log('debug', msg, ...rest);
  }
  info(msg: string, ...rest: unknown[]): void {
    this.log('info', msg, ...rest);
  }
  warn(msg: string, ...rest: unknown[]): void {
    this.log('warn', msg, ...rest);
  }
  error(msg: string, ...rest: unknown[]): void {
    this.log('error', msg, ...rest);
  }
}

export function createLogger(prefix: string, minLevel: LogLevel = 'info'): Logger {
  return new Logger(prefix, minLevel);
}
