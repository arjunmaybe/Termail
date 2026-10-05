/**
 * B12 — SMTP envelope trimming.
 *
 * Transport must send trimmed MAIL FROM / RCPT TO values when the
 * envelope carries padding. BCC stays envelope-only (never a DATA header).
 */

import { describe, expect, it } from 'vitest';
import {
  NodeSmtpTransport,
  type LineSocket,
} from '../../src/core/smtp/transport.js';

type DataListener = (chunk: any) => void;

class FakeSocket implements LineSocket {
  written: string[] = [];
  destroyed = false;
  private dataListeners: DataListener[] = [];
  private onceListeners = new Map<string, Array<(...args: any[]) => void>>();

  constructor(private readonly onWrite?: (chunk: string, sock: FakeSocket) => void) {}

  write(data: string): boolean {
    this.written.push(data);
    if (this.onWrite) {
      const chunk = data;
      setTimeout(() => {
        if (!this.destroyed) this.onWrite?.(chunk, this);
      }, 0);
    }
    return true;
  }

  end(): void {}
  destroy(): void {
    this.destroyed = true;
  }
  once(event: string, listener: (...args: any[]) => void): unknown {
    const list = this.onceListeners.get(event) ?? [];
    list.push(listener);
    this.onceListeners.set(event, list);
    return this;
  }
  on(event: string, listener: (...args: any[]) => void): unknown {
    if (event === 'data') this.dataListeners.push(listener as DataListener);
    else {
      const list = this.onceListeners.get(event) ?? [];
      list.push(listener);
      this.onceListeners.set(event, list);
    }
    return this;
  }
  removeListener(event: string, listener: (...args: any[]) => void): unknown {
    if (event === 'data') this.dataListeners = this.dataListeners.filter((l) => l !== (listener as DataListener));
    else this.onceListeners.set(event, (this.onceListeners.get(event) ?? []).filter((l) => l !== listener));
    return this;
  }
  serverPush(chunk: string): void {
    setTimeout(() => {
      if (this.destroyed) return;
      for (const l of [...this.dataListeners]) l(Buffer.from(chunk, 'utf8'));
    }, 0);
  }
}

const SHORT = { connectionTimeoutMs: 500, greetingTimeoutMs: 500, commandTimeoutMs: 500 };

describe('B12 envelope trimming', () => {
  it('trims padded from/to/cc/bcc on the wire', async () => {
    let dataPayload = '';
    const sock = new FakeSocket((chunk, s) => {
      const cmd = chunk.trimEnd();
      if (cmd.startsWith('EHLO')) s.serverPush('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (cmd.startsWith('AUTH PLAIN')) s.serverPush('235 ok\r\n');
      else if (cmd.startsWith('MAIL FROM')) s.serverPush('250 OK\r\n');
      else if (cmd.startsWith('RCPT TO')) s.serverPush('250 OK\r\n');
      else if (cmd === 'DATA') s.serverPush('354 go\r\n');
      else if (cmd === 'QUIT') s.serverPush('221 Bye\r\n');
      else if (chunk.includes('\r\n.\r\n')) {
        dataPayload = chunk;
        s.serverPush('250 OK queued\r\n');
      }
    });
    const drivingTransport = new NodeSmtpTransport({
      host: 'smtp.example.com',
      port: 465,
      mode: 'implicit-tls',
      user: 'me@example.com',
      secret: 'dummy-password-123',
      timeouts: SHORT,
      hooks: {
        connectTls: async () => {
          sock.serverPush('220 smtp.example.com ready\r\n');
          return sock;
        },
        connectTcp: async () => {
          throw new Error('unused');
        },
        upgradeTls: async () => {
          throw new Error('unused');
        },
      },
    });
    await drivingTransport.send({
      from: '  me@example.com  ',
      to: ['  to@example.com '],
      cc: ['\tcc@example.com\n'],
      bcc: ['  hidden@example.com  '],
      subject: 's',
      body: 'b',
    });

    const written = sock.written.join('');
    expect(written).toContain('MAIL FROM:<me@example.com>');
    expect(written).not.toContain('MAIL FROM:<  me@example.com');
    expect(written).toContain('RCPT TO:<to@example.com>');
    expect(written).toContain('RCPT TO:<cc@example.com>');
    expect(written).toContain('RCPT TO:<hidden@example.com>');
    expect(written).not.toMatch(/RCPT TO:<\s/);
    // BCC remains envelope-only.
    expect(dataPayload).not.toMatch(/Bcc:/i);
    expect(dataPayload).not.toMatch(/hidden@example\.com/);
    expect(dataPayload).toContain('To: to@example.com');
  });

  it('preserves existing BCC envelope-only behavior', async () => {
    let dataPayload = '';
    const sock = new FakeSocket((chunk, s) => {
      const cmd = chunk.trimEnd();
      if (cmd.startsWith('EHLO')) s.serverPush('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (cmd.startsWith('AUTH PLAIN')) s.serverPush('235 ok\r\n');
      else if (cmd.startsWith('MAIL FROM')) s.serverPush('250 OK\r\n');
      else if (cmd.startsWith('RCPT TO')) s.serverPush('250 OK\r\n');
      else if (cmd === 'DATA') s.serverPush('354 go\r\n');
      else if (cmd === 'QUIT') s.serverPush('221 Bye\r\n');
      else if (chunk.includes('\r\n.\r\n')) {
        dataPayload = chunk;
        s.serverPush('250 OK queued\r\n');
      }
    });
    const transport = new NodeSmtpTransport({
      host: 'smtp.example.com',
      port: 465,
      mode: 'implicit-tls',
      user: 'me@example.com',
      secret: 'dummy-password-123',
      timeouts: SHORT,
      hooks: {
        connectTls: async () => {
          sock.serverPush('220 smtp.example.com ready\r\n');
          return sock;
        },
        connectTcp: async () => {
          throw new Error('unused');
        },
        upgradeTls: async () => {
          throw new Error('unused');
        },
      },
    });
    await transport.send({
      from: 'me@example.com',
      to: ['to@example.com'],
      cc: [],
      bcc: ['hidden@example.com'],
      subject: 'hi',
      body: 'hello',
    });
    expect(dataPayload).not.toMatch(/Bcc:/i);
    expect(dataPayload).not.toMatch(/hidden@example\.com/);
    expect(sock.written.join('')).toContain('RCPT TO:<hidden@example.com>');
  });
});
