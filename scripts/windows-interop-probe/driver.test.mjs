// Pure parser/observation checks: no process spawn, sockets, or Windows fixture execution.
import assert from 'node:assert/strict';
import { Frames, validateReady } from './driver.mjs';

const crt = { mode: 'crt', pid: 1234, fd: 3, sourceHandle: '0xabc', ownedHandle: '0xdef',
  fileType: 3, pipeFlags: 0, pipeState: 0, handleFlags: 0, outBuffer: 4096,
  inBuffer: 4096, crtSourceClosed: true };
const ready = (record) => `ready ${JSON.stringify(record)}`;
const frames = new Frames();
assert.deepEqual(frames.push('rea'), []);
assert.deepEqual(frames.push('dy {}\npong\n'), ['ready {}', 'pong']);
frames.end();
assert.equal(validateReady(ready(crt), 'crt', 1234).fd, 3);
const named = { ...crt, mode: 'named', fd: null, crtSourceClosed: false, ownedHandle: '0xabc' };
assert.equal(validateReady(ready(named), 'named', 1234).fd, null);
for (const changed of [ { pid: 999 }, { fd: 0xabc }, { pipeFlags: 4 }, { pipeState: 2 },
  { handleFlags: 1 }, { crtSourceClosed: false }, { ownedHandle: '0xabc' },
  { sourceHandle: 3 }, { inBuffer: -1 }, { pipeFlags: 2 ** 32 } ]) {
  assert.throws(() => validateReady(ready({ ...crt, ...changed }), 'crt', 1234));
}
assert.throws(() => validateReady('pong', 'crt', 1234));
assert.throws(() => validateReady('ready {', 'crt', 1234));
assert.throws(() => new Frames().push('x'.repeat(1025)));
assert.throws(() => new Frames().push(`${'x'.repeat(1024)}\n`));
assert.throws(() => new Frames().push('\u00ff\n'));
const truncated = new Frames();
truncated.push('pong');
assert.throws(() => truncated.end());
console.log('PASS: split/coalesced framing, byte limits, truncation, PID observation, fd/HANDLE distinction, pipe modes, ownership metadata; no spawn.');
