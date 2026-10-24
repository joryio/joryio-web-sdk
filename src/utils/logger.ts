/**
 * Simple logger utility for SDK debugging
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export class Logger {
  private enabled: boolean;
  private level: LogLevel;

  constructor(enabled: boolean, level: LogLevel = 'error') {
    this.enabled = enabled;
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.enabled && LOG_LEVELS[level] <= LOG_LEVELS[this.level];
  }

  error(...args: any[]): void {
    if (this.shouldLog('error')) {
      console.error('[Joryio SDK]', ...args);
    }
  }

  warn(...args: any[]): void {
    if (this.shouldLog('warn')) {
      console.warn('[Joryio SDK]', ...args);
    }
  }

  info(...args: any[]): void {
    if (this.shouldLog('info')) {
      console.info('[Joryio SDK]', ...args);
    }
  }

  debug(...args: any[]): void {
    if (this.shouldLog('debug')) {
      console.debug('[Joryio SDK]', ...args);
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }
}
