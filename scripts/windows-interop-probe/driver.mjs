// SPDX-License-Identifier: BSD-3-Clause
// Public Node APIs only. Stage 1 byte-I/O probe, not a procward adapter.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export class Frames {
  buffered = '';
  push(chunk) {
    if (!/^[\x20-\x7e\n]*$/.test(chunk)) throw new Error('non-ASCII frame');
    this.buffered += chunk;
    const lines = [];
    for (;;) {
      const end = this.buffered.indexOf('\n');
      if (end < 0) {
        if (this.buffered.length > 1024) throw new Error('oversized frame');
        return lines;
      }
      if (end + 1 > 1024) throw new Error('oversized frame');
      lines.push(this.buffered.slice(0, end));
      this.buffered = this.buffered.slice(end + 1);
    }
  }
  end() { assert.equal(this.buffered, '', 'truncated frame'); }
}
export function validateReady(line, mode, pid) {
  assert.ok(line.startsWith('ready '), 'expected ready');
  const record = JSON.parse(line.slice(6));
  assert.equal(record.mode, mode);
  assert.equal(record.pid, pid, 'observed payload PID differs from spawned PID');
  assert.equal(record.fd, mode === 'crt' ? 3 : null);
  assert.match(record.sourceHandle, /^0x[0-9a-f]+$/);
  assert.match(record.ownedHandle, /^0x[0-9a-f]+$/);
  assert.equal(record.fileType, 3);
  for (const key of ['pipeFlags', 'pipeState', 'handleFlags', 'outBuffer', 'inBuffer']) {
    assert.ok(Number.isSafeInteger(record[key]) && record[key] >= 0 && record[key] <= 0xffffffff, key);
  }
  assert.equal(record.pipeFlags & 4, 0, 'message-type pipe');
  assert.equal(record.pipeState & 2, 0, 'message read mode');
  assert.equal(record.handleFlags & 1, 0, 'inheritable owned endpoint');
  assert.equal(record.crtSourceClosed, mode === 'crt');
  if (mode === 'crt') assert.notEqual(record.sourceHandle, record.ownedHandle);
  return record;
}

function runCase(fixture, mode) {
  return new Promise((resolveCase) => {
    const result = { case: mode, status: 'failed', guardFired: false, stdout: '', stderr: '',
      exitCode: null, signal: null, childPid: null, ready: null, controlEOF: false,
      controlClosed: false, listenerClosed: mode === 'crt', childClosed: false,
      killRequested: false, peerIdentity: 'payload/PID observations only; NOT authenticated' };
    let child;
    let server;
    let control;
    let finished = false;
    let settled = false;
    let phase = 'ready';
    let cleanupTimer;
    const frames = new Frames();
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(cleanupTimer);
      // Release only this case's resources; never claim whole-tree cleanup.
      child?.unref();
      server?.unref();
      resolveCase(result);
    };
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(guard);
      if (!error) {
        result.status = 'passed';
        settle();
        return;
      }
      result.error = String(error.message ?? error);
      if (child && !result.childClosed && child.exitCode === null && child.signalCode === null) {
        result.killRequested = true;
        try { result.killAccepted = child.kill(); }
        catch (killError) { result.killError = String(killError); }
      }
      control?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      // server.close() is idempotently requested only while listening.
      if (server?.listening) server.close();
      cleanupTimer = setTimeout(() => {
        result.guardFired = true;
        result.cleanupGuardFired = true;
        settle();
      }, 2000);
      cleanupDone();
    };
    const cleanupDone = () => {
      if (finished && (!child || result.childClosed) && (!server || result.listenerClosed)) settle();
    };
    const advance = () => {
      if (finished || !result.childClosed) return;
      try {
        if (mode === 'crt' && result.exitCode === 78 &&
            result.stdout.includes('PROBE_UNSUPPORTED crt-fd3-unavailable\n')) {
          finished = true;
          clearTimeout(guard);
          result.status = 'unsupported';
          result.error = 'child CRT index 3 unavailable; no named-pipe fallback';
          control?.destroy();
          settle();
          return;
        }
        assert.equal(result.exitCode, 17, 'fixture must retain its ordinary nonzero exit');
        assert.equal(result.signal, null);
        assert.ok(result.stdout.includes('PROBE_STDOUT_BEGIN\n'));
        assert.ok(result.stdout.includes('PROBE_STDOUT_END\n'));
        assert.ok(result.stdout.includes('PROBE_CONTROL_EOF\n'), 'child must observe EOF');
        assert.ok(result.stderr.includes('PROBE_STDERR_MARKER\n'));
        assert.equal(phase, 'eof', 'ready/ping/pong incomplete');
        if (result.controlEOF && result.controlClosed && result.listenerClosed) finish();
      } catch (error) { finish(error); }
    };
    const guard = setTimeout(() => {
      result.guardFired = true;
      finish(new Error('8s case guard fired; failed, never rescued as success'));
    }, 8000);
    const attach = (stream) => {
      if (control) { stream.destroy(); finish(new Error('unexpected second connection')); return; }
      control = stream;
      if (!control || typeof control.write !== 'function') {
        finish(new Error('public duplex stdio[3] stream unavailable')); return;
      }
      control.setEncoding('utf8');
      control.on('error', finish);
      control.on('data', (chunk) => {
        if (finished) return;
        try {
          for (const line of frames.push(chunk)) {
            if (phase === 'ready') {
              result.ready = validateReady(line, mode, child.pid);
              phase = 'pong';
              control.write('ping\n');
            } else if (phase === 'pong') {
              assert.equal(line, 'pong');
              phase = 'eof';
              control.end();
            } else throw new Error('unexpected extra frame');
          }
        } catch (error) { finish(error); }
      });
      control.on('end', () => {
        try { frames.end(); result.controlEOF = true; advance(); }
        catch (error) { finish(error); }
      });
      control.on('close', () => { result.controlClosed = true; advance(); cleanupDone(); });
    };
    const launch = (path) => {
      if (finished) return;
      try {
        child = spawn(fixture, mode === 'crt' ? ['crt'] : ['named', path], {
          stdio: mode === 'crt' ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        result.childPid = child.pid ?? null;
        child.on('error', finish);
        for (const name of ['stdout', 'stderr']) {
          child[name].setEncoding('utf8');
          child[name].on('error', finish);
          child[name].on('data', (chunk) => {
            if (result[name].length + chunk.length > 65536) finish(new Error(`${name} exceeds 64KiB`));
            else result[name] += chunk.replaceAll('\r\n', '\n');
          });
        }
        child.on('close', (code, signal) => {
          result.childClosed = true; result.exitCode = code; result.signal = signal;
          advance(); cleanupDone();
        });
        if (mode === 'crt') attach(child.stdio[3]);
      } catch (error) { finish(error); }
    };
    if (mode === 'crt') launch();
    else {
      const path = `\\\\.\\pipe\\pi-interop-${process.pid}-${randomUUID()}`;
      result.pipePath = path;
      try {
        server = createServer({ allowHalfOpen: true }, (socket) => {
          if (finished) { socket.destroy(); return; }
          try {
            attach(socket);
            // Stop accepting immediately, but wait for the accepted socket to close.
            if (server.listening) server.close();
          } catch (error) { socket.destroy(); finish(error); }
        });
        server.on('error', finish);
        server.on('close', () => { result.listenerClosed = true; advance(); cleanupDone(); });
        server.listen(path, () => { if (finished) server.close(); else launch(path); });
      } catch (error) { finish(error); }
    }
  });
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('REFUSED: genuine Windows only; no child was spawned. Import parser tests separately.');
    process.exitCode = 2;
    return;
  }
  const runtime = process.versions.bun ? 'bun' : 'node';
  const version = process.versions.bun ?? process.versions.node;
  assert.equal(version, runtime === 'bun' ? '1.4.4' : '22.22.2', 'wrong probe runtime version');
  assert.equal(process.argv.length, 4, 'usage: node|bun driver.mjs ABSOLUTE_FIXTURE_EXE crt|named');
  assert.ok(['crt', 'named'].includes(process.argv[3]), 'case must be crt or named');
  const fixture = resolve(process.argv[2]);
  const report = { stage: 1, runtime, version, nodeCompatibilityVersion: process.versions.node,
    platform: process.platform, arch: process.arch, fixture,
    fixtureSha256: createHash('sha256').update(readFileSync(fixture)).digest('hex'),
    driverSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
    cases: [] };
  // One explicit experiment per invocation; no automatic alternate mechanism or CLI.
  report.cases.push(await runCase(fixture, process.argv[3]));
  console.log(JSON.stringify(report, null, 2));
  if (report.cases.some((entry) => entry.status !== 'passed')) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(`PROBE_SETUP_FAILURE: ${error.stack ?? error}`); process.exitCode = 1; });
}
