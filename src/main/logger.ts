/**
 * Простой логгер Brouser.
 *
 * Каждая запись:
 *  1) печатается в консоль main-процесса;
 *  2) дописывается в файл app.log в папке userData;
 *  3) транслируется в renderer (канал 'log-message') для панели журнала.
 *
 * Ошибки логирования никогда не роняют приложение.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { LogEntry, LogLevel } from './types';

export class Logger {
  private filePath = '';
  private recent: LogEntry[] = [];
  private broadcast: (entry: LogEntry) => void = () => {};

  /** Вызывается после app.ready (нужен app.getPath('userData')). */
  init(): void {
    try {
      this.filePath = path.join(app.getPath('userData'), 'app.log');
      fs.appendFileSync(this.filePath, `\n=== Brouser started at ${new Date().toISOString()} ===\n`);
    } catch (err) {
      console.error('[Brouser] logger init failed:', err);
    }
  }

  /** main подключает колбэк, чтобы отправлять записи в renderer. */
  setBroadcast(fn: (entry: LogEntry) => void): void {
    this.broadcast = fn;
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  /** Последние записи для панели журнала и state:get. */
  getRecent(limit = 60): LogEntry[] {
    return this.recent.slice(-limit);
  }

  private write(level: LogLevel, message: string): void {
    const entry: LogEntry = { time: Date.now(), level, message };
    const line = `${new Date().toISOString()} [${level.toUpperCase().padEnd(5)}] ${message}`;
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
    // Пишем в файл; сбой записи (например, нет доступа к диску) — не критичен.
    try {
      fs.appendFileSync(this.filePath, line + '\n');
    } catch {
      /* молча: лог не должен ронять приложение */
    }
    // Кольцевой буфер для UI.
    this.recent.push(entry);
    if (this.recent.length > 300) this.recent.shift();
    // Трансляция в renderer.
    try {
      this.broadcast(entry);
    } catch {
      /* ignore */
    }
  }
}
