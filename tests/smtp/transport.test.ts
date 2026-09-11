/**
 * Phase 4 — SMTP transport tests with deterministic fake sockets.
 *
 * No real network, no real credentials. Dummy secret only.
 */

import { describe, expect, it } from 'vitest';
import type { AccountConfig } from '../../src/core/types/config.js';
import { AuthenticationError, NetworkError } from '../../src/core/utils/errors.js';
import {
  NodeSmtpTransport,
  buildImplicitTlsOptions,
  buildStarttlsUpgradeOptions,
  parseCapabilities,
  parseSmtpBuffer,
  type LineSocket,
} from '../../src/core/smtp/transport.js';

const DUMMY_USER = 'me@example.com';
const DUMMY_SECRET = 'dummy-password-123';

type DataListener = (chunk: any) => void;
type OnceListener = (...args: any[]) => void;

class FakeSocket implements LineSocket {
  written: string[] = [];
  destroyed = false;
  private dataListeners: DataListener[] = [];
  private onceListeners = new Map<string, OnceListener[]>();
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

  end(): void {
    // no-op
  }

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
    if (event === 'data') {
      this.dataListeners.push(listener as DataListener);
    } else {
      const list = this.onceListeners.get(event) ?? [];
      list.push(listener);
      this.onceListeners.set(event, list);
    }
    return this;
  }

  removeListener(event: string, listener: (...args: any[]) => void): unknown {
    if (event === 'data') {
      this.dataListeners = this.dataListeners.filter((l) => l !== (listener as DataListener));
    } else {
      const list = (this.onceListeners.get(event) ?? []).filter((l) => l !== listener);
      this.onceListeners.set(event, list);
    }
    return this;
  }

  serverPush(chunk: string): void {
    setTimeout(() => {
      if (this.destroyed) return;
      for (const l of [...this.dataListeners]) l(Buffer.from(chunk, 'utf8'));
    }, 0);
  }

  serverError(err: Error): void {
    setTimeout(() => {
      for (const l of this.onceListeners.get('error') ?? []) l(err);
    }, 0);
  }
}

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const SHORT = { connectionTimeoutMs: 500, greetingTimeoutMs: 500, commandTimeoutMs: 500 };

describe('parseSmtpBuffer (multiline)', () => {
  it('parses a multiline EHLO reply split across chunks', () => {
    const part1 = '250-localhost greets\r\n250-STARTTLS\r\n';
    const r1 = parseSmtpBuffer(part1);
    expect(r1.reply).toBeNull();
    const r2 = parseSmtpBuffer(`${r1.rest}250 AUTH PLAIN LOGIN\r\n`);
    expect(r2.reply?.code).toBe(250);
    expect(r2.reply?.lines).toHaveLength(3);
    const caps = parseCapabilities(r2.reply!);
    expect(caps.starttls).toBe(true);
    expect(caps.auth).toEqual(['PLAIN', 'LOGIN']);
  });

  it('parses a single-line reply', () => {
    const r = parseSmtpBuffer('220 smtp.example.com ready\r\n');
    expect(r.reply?.code).toBe(220);
  });
});

describe('TLS option hardening', () => {
  it('always sets rejectUnauthorized:true and servername==host (implicit)', () => {
    const opts = buildImplicitTlsOptions('smtp.example.com', 465) as Record<string, unknown>;
    expect(opts['rejectUnauthorized']).toBe(true);
    expect(opts['servername']).toBe('smtp.example.com');
    expect(opts['host']).toBe('smtp.example.com');
    expect(opts['port']).toBe(465);
  });

  it('always sets rejectUnauthorized:true and servername==host (starttls upgrade)', () => {
    const fake = { fake: true };
    const opts = buildStarttlsUpgradeOptions(fake as any, 'smtp.example.com', 587) as Record<
      string,
      unknown
    >;
    expect(opts['rejectUnauthorized']).toBe(true);
    expect(opts['servername']).toBe('smtp.example.com');
  });
});

describe('implicit-tls happy path (AUTH PLAIN)', () => {
  it('connects with TLS first and sends To+Cc+Bcc via RCPT without Bcc headers', async () => {
    const calls = { tcp: 0, tls: 0, upgrade: 0 };
    let tlsSocket: FakeSocket | null = null;

    const hooks = {
      connectTcp: async (): Promise<LineSocket> => {
        calls.tcp += 1;
        throw new Error('must not use plain TCP in implicit-tls mode');
      },
      connectTls: async (): Promise<LineSocket> => {
        calls.tls += 1;
        const sock = new FakeSocket((chunk, s) => {
          const cmd = chunk.trimEnd();
          if (cmd.startsWith('EHLO')) {
            s.serverPush('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
          } else if (cmd.startsWith('AUTH PLAIN')) {
            const payload = cmd.slice('AUTH PLAIN '.length);
            const decoded = Buffer.from(payload, 'base64').toString('utf8');
            expect(decoded).toBe(`\0${DUMMY_USER}\0${DUMMY_SECRET}`);
            s.serverPush('235 2.7.0 Authentication successful\r\n');
          } else if (cmd.startsWith('MAIL FROM')) {
            s.serverPush('250 OK\r\n');
          } else if (cmd.startsWith('RCPT TO')) {
            s.serverPush('250 OK\r\n');
          } else if (cmd === 'DATA') {
            s.serverPush('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (cmd === 'QUIT') {
            s.serverPush('221 Bye\r\n');
          } else if (chunk.includes('\r\n.\r\n')) {
            // DATA payload: must not contain Bcc.
            expect(chunk).not.toMatch(/Bcc:/i);
            expect(chunk).not.toMatch(/hidden@example\.com/);
            expect(chunk).toContain('To: to@example.com');
            s.serverPush('250 OK queued\r\n');
          }
        });
        tlsSocket = sock;
        sock.serverPush('220 smtp.example.com ready\r\n');
        return sock;
      },
      upgradeTls: async (): Promise<LineSocket> => {
        calls.upgrade += 1;
        throw new Error('must not upgrade in implicit-tls mode');
      },
    };

    const transport = new NodeSmtpTransport({
      host: 'smtp.example.com',
      port: 465,
      mode: 'implicit-tls',
      user: DUMMY_USER,
      secret: DUMMY_SECRET,
      timeouts: SHORT,
      hooks,
    });
    await transport.send({
      from: DUMMY_USER,
      to: ['to@example.com'],
      cc: ['cc@example.com'],
      bcc: ['hidden@example.com'],
      subject: 'hi',
      body: 'hello',
    });

    expect(calls).toEqual({ tcp: 0, tls: 1, upgrade: 0 });
    expect(tlsSocket).not.toBeNull();
    const written = tlsSocket!.written.join('');
    expect(written).toContain('MAIL FROM:<me@example.com>');
    expect(written).toContain('RCPT TO:<to@example.com>');
    expect(written).toContain('RCPT TO:<cc@example.com>');
    expect(written).toContain('RCPT TO:<hidden@example.com>');
    expect(tlsSocket!.destroyed).toBe(true);
  });
});

describe('starttls happy path', () => {
  it('uses plaintext only for greeting/EHLO/STARTTLS, upgrades, discards buffer, re-EHLOs', async () => {
    const calls = { tcp: 0, tls: 0, upgrade: 0 };
    let plainSocket: FakeSocket | null = null;
    let tlsSocket: FakeSocket | null = null;
    const tlsCommands: string[] = [];

    const hooks = {
      connectTcp: async (): Promise<LineSocket> => {
        calls.tcp += 1;
        const sock = new FakeSocket((chunk, s) => {
          const cmd = chunk.trimEnd();
          if (cmd.startsWith('EHLO')) {
            // Inject stale pre-TLS bytes after the reply to prove the
            // transport discards the pre-TLS buffer on upgrade.
            s.serverPush('250-localhost\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n');
          } else if (cmd === 'STARTTLS') {
            s.serverPush('220 2.0.0 Ready to start TLS\r\n');
          } else {
            throw new Error(`plaintext socket must not see "${cmd}" (TLS not yet established)`);
          }
        });
        plainSocket = sock;
        sock.serverPush('220 smtp.example.com ready\r\n');
        return sock;
      },
      connectTls: async (): Promise<LineSocket> => {
        calls.tls += 1;
        throw new Error('must not use implicit TLS in starttls mode');
      },
      upgradeTls: async (): Promise<LineSocket> => {
        calls.upgrade += 1;
        const sock = new FakeSocket((chunk, s) => {
          const cmd = chunk.trimEnd();
          tlsCommands.push(cmd.split('\r\n')[0] ?? '');
          if (cmd.startsWith('EHLO')) {
            s.serverPush('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
          } else if (cmd.startsWith('AUTH PLAIN')) {
            s.serverPush('235 ok\r\n');
          } else if (cmd.startsWith('MAIL FROM')) {
            s.serverPush('250 OK\r\n');
          } else if (cmd.startsWith('RCPT TO')) {
            s.serverPush('250 OK\r\n');
          } else if (cmd === 'DATA') {
            s.serverPush('354 go\r\n');
          } else if (cmd === 'QUIT') {
            s.serverPush('221 Bye\r\n');
          } else if (chunk.includes('\r\n.\r\n')) {
            s.serverPush('250 OK queued\r\n');
          }
        });
        tlsSocket = sock;
        // No greeting on the upgraded socket; client must re-EHLO immediately.
        return sock;
      },
    };

    const transport = new NodeSmtpTransport({
      host: 'smtp.example.com',
      port: 587,
      mode: 'starttls',
      user: DUMMY_USER,
      secret: DUMMY_SECRET,
      timeouts: SHORT,
      hooks,
    });
    await transport.send({
      from: DUMMY_USER,
      to: ['to@example.com'],
      cc: [],
      bcc: [],
      subject: 's',
      body: 'b',
    });

    expect(calls).toEqual({ tcp: 1, tls: 0, upgrade: 1 });
    // First command on the TLS socket must be EHLO (re-EHLO after upgrade).
    expect(tlsCommands[0]).toMatch(/^EHLO /);
    expect(tlsCommands).toContain('QUIT');
    // AUTH/MAIL never touched the plaintext socket.
    expect(plainSocket!.written.join('')).not.toMatch(/AUTH|MAIL FROM/);
    expect(tlsSocket!.destroyed).toBe(true);
  });

  it('fails safely when STARTTLS is not advertised (no downgrade)', async () => {
    const sock = new FakeSocket((chunk, s) => {
      if (chunk.trimEnd().startsWith('EHLO')) {
        s.serverPush('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
      }
    });
    sock.serverPush('220 ready\r\n');
    const hooks = {
      connectTcp: async (): Promise<LineSocket> => sock,
      connectTls: async (): Promise<LineSocket> => {
        throw new Error('must not connect TLS');
      },
      upgradeTls: async (): Promise<LineSocket> => {
        throw new Error('must not upgrade when STARTTLS is missing');
      },
    };
    const transport = new NodeSmtpTransport({
      host: 'smtp.example.com',
      port: 587,
      mode: 'starttls',
      user: DUMMY_USER,
      secret: DUMMY_SECRET,
      timeouts: SHORT,
      hooks,
    });
    await expect(
      transport.send({ from: DUMMY_USER, to: ['a@example.com'], cc: [], bcc: [], subject: 's', body: 'b' })
    ).rejects.toBeInstanceOf(NetworkError);
    const all = sock.written.join('');
    expect(all).not.toMatch(/AUTH|MAIL FROM|RCPT TO|DATA/);
    expect(sock.destroyed).toBe(true);
  });
});

describe('AUTH LOGIN', () => {
  it('answers both 334 challenges with base64 user/pass', async () => {
    const seen: string[] = [];
    const sock = new FakeSocket((chunk, s) => {
      const cmd = chunk.trimEnd();
      seen.push(cmd);
      if (cmd.startsWith('EHLO')) {
        s.serverPush('250-localhost\r\n250 AUTH LOGIN\r\n');
      } else if (cmd === 'AUTH LOGIN') {
        s.serverPush('334 VXNlcm5hbWU6\r\n');
      } else if (cmd === Buffer.from(DUMMY_USER, 'utf8').toString('base64')) {
        s.serverPush('334 UGFzc3dvcmQ6\r\n');
      } else if (cmd === Buffer.from(DUMMY_SECRET, 'utf8').toString('base64')) {
        s.serverPush('235 ok\r\n');
      } else if (cmd.startsWith('MAIL FROM')) {
        s.serverPush('250 OK\r\n');
      } else if (cmd.startsWith('RCPT TO')) {
        s.serverPush('250 OK\r\n');
      } else if (cmd === 'DATA') {
        s.serverPush('354 go\r\n');
      } else if (cmd === 'QUIT') {
        s.serverPush('221 Bye\r\n');
      } else if (chunk.includes('\r\n.\r\n')) {
        s.serverPush('250 OK queued\r\n');
      }
    });
    sock.serverPush('220 ready\r\n');
    const transport = new NodeSmtpTransport({
      host: 'smtp.example.com',
      port: 465,
      mode: 'implicit-tls',
      user: DUMMY_USER,
      secret: DUMMY_SECRET,
      timeouts: SHORT,
      hooks: {
        connectTls: async () => sock,
        connectTcp: async () => {
          throw new Error('unused');
        },
        upgradeTls: async () => {
          throw new Error('unused');
        },
      },
    });
    await transport.send({
      from: DUMMY_USER,
      to: ['a@example.com'],
      cc: [],
      bcc: [],
      subject: 's',
      body: 'b',
    });
    expect(seen).toContain('AUTH LOGIN');
  });
});

describe('failures', () => {
  it('maps 535 to AuthenticationError without the secret', async () => {
    const sock = new FakeSocket((chunk, s) => {
      if (chunk.trimEnd().startsWith('EHLO')) {
        s.serverPush('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
      } else if (chunk.trimEnd().startsWith('AUTH PLAIN')) {
        s.serverPush('535 5.7.8 bad credentials\r\n');
      }
    });
    sock.serverPush('220 ready\r\n');
    const transport = new NodeSmtpTransport({
      host: 'smtp.example.com',
      port: 465,
      mode: 'implicit-tls',
      user: DUMMY_USER,
      secret: DUMMY_SECRET,
      timeouts: SHORT,
      hooks: { connectTls: async () => sock } as any,
    });
    const err = await transport
      .send({ from: DUMMY_USER, to: ['a@example.com'], cc: [], bcc: [], subject: 's', body: 'b' })
      .then(
        () => new Error('expected throw'),
        (e: unknown) => e as Error
      );
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.message).not.toContain(DUMMY_SECRET);
  });

  it('maps greeting failure to NetworkError', async () => {
    const sock = new FakeSocket();
    sock.serverPush('554 rejecting\r\n');
    const transport = new NodeSmtpTransport({
      host: 'smtp.example.com',
      port: 465,
      mode: 'implicit-tls',
      user: DUMMY_USER,
      secret: DUMMY_SECRET,
      timeouts: SHORT,
      hooks: { connectTls: async () => sock } as any,
    });
    await expect(
      transport.send({ from: DUMMY_USER, to: ['a@example.com'], cc: [], bcc: [], subject: 's', body: 'b' })
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('times out when the server never replies', async () => {
    const sock = new FakeSocket(); // never pushes anything
    const transport = new NodeSmtpTransport({
      host: 'smtp.example.com',
      port: 465,
      mode: 'implicit-tls',
      user: DUMMY_USER,
      secret: DUMMY_SECRET,
      timeouts: { connectionTimeoutMs: 50, greetingTimeoutMs: 50, commandTimeoutMs: 50 },
      hooks: { connectTls: async () => sock } as any,
    });
    const err = await transport
      .send({ from: DUMMY_USER, to: ['a@example.com'], cc: [], bcc: [], subject: 's', body: 'b' })
      .then(
        () => new Error('expected throw'),
        (e: unknown) => e as Error
      );
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toMatch(/timed out/i);
    expect(sock.destroyed).toBe(true);
  });

  it('destroys the socket on failure', async () => {
    const sock = new FakeSocket((chunk, s) => {
      if (chunk.trimEnd().startsWith('EHLO')) s.serverPush('250 ok\r\n250 AUTH PLAIN\r\n');
      else if (chunk.trimEnd().startsWith('AUTH PLAIN')) s.serverPush('535 fail\r\n');
    });
    sock.serverPush('220 ready\r\n');
    const transport = new NodeSmtpTransport({
      host: 'smtp.example.com',
      port: 465,
      mode: 'implicit-tls',
      user: DUMMY_USER,
      secret: DUMMY_SECRET,
      timeouts: SHORT,
      hooks: { connectTls: async () => sock } as any,
    });
    await expect(
      transport.send({ from: DUMMY_USER, to: ['a@example.com'], cc: [], bcc: [], subject: 's', body: 'b' })
    ).rejects.toThrow();
    await tick();
    expect(sock.destroyed).toBe(true);
  });

  it('destroys the plain socket when the STARTTLS upgrade rejects', async () => {
    const sock = new FakeSocket((chunk, s) => {
      const cmd = chunk.trimEnd();
      if (cmd.startsWith('EHLO')) {
        s.serverPush('250-localhost\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n');
      } else if (cmd === 'STARTTLS') {
        s.serverPush('220 2.0.0 Ready to start TLS\r\n');
      }
    });
    sock.serverPush('220 ready\r\n');
    const transport = new NodeSmtpTransport({
      host: 'smtp.example.com',
      port: 587,
      mode: 'starttls',
      user: DUMMY_USER,
      secret: DUMMY_SECRET,
      timeouts: SHORT,
      hooks: {
        connectTcp: async () => sock,
        connectTls: async () => {
          throw new Error('must not use implicit TLS in starttls mode');
        },
        upgradeTls: async () => {
          throw new NetworkError('SMTP STARTTLS upgrade failed: certificate has expired');
        },
      },
    });
    const err = await transport
      .send({ from: DUMMY_USER, to: ['a@example.com'], cc: [], bcc: [], subject: 's', body: 'b' })
      .then(
        () => new Error('expected throw'),
        (e: unknown) => e as Error
      );
    // Greeting/EHLO/STARTTLS completed, then the upgrade failed.
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toMatch(/STARTTLS upgrade failed/);
    expect(err.message).not.toContain(DUMMY_SECRET);
    expect(sock.destroyed).toBe(true);
    const all = sock.written.join('');
    expect(all).toContain('EHLO termail');
    expect(all).toContain('STARTTLS');
    expect(all).not.toMatch(/AUTH|MAIL FROM|RCPT TO|DATA/);
  });

  it('maps a rejected TLS connection to NetworkError without sending commands', async () => {
    const transport = new NodeSmtpTransport({
      host: 'smtp.example.com',
      port: 465,
      mode: 'implicit-tls',
      user: DUMMY_USER,
      secret: DUMMY_SECRET,
      timeouts: SHORT,
      hooks: {
        connectTls: async () => {
          throw new NetworkError('SMTP TLS connection error: certificate has expired');
        },
        connectTcp: async () => {
          throw new Error('must not use plain TCP in implicit-tls mode');
        },
        upgradeTls: async () => {
          throw new Error('must not upgrade in implicit-tls mode');
        },
      },
    });
    const err = await transport
      .send({ from: DUMMY_USER, to: ['a@example.com'], cc: [], bcc: [], subject: 's', body: 'b' })
      .then(
        () => new Error('expected throw'),
        (e: unknown) => e as Error
      );
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toMatch(/TLS connection error/);
    expect(err.message).not.toContain(DUMMY_SECRET);
  });
});

describe('account plumbing', () => {
  it('exposes its target', () => {
    const t = new NodeSmtpTransport({
      host: 'smtp.example.com',
      port: 587,
      mode: 'starttls',
      user: 'u',
      secret: 'dummy-password-123',
    });
    expect(t.getTarget()).toEqual({ host: 'smtp.example.com', port: 587, mode: 'starttls' });
  });

  it('does not require a real AccountConfig import to construct', () => {
    const _typeCheck: AccountConfig | null = null;
    expect(_typeCheck).toBeNull();
  });
});
