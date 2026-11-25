import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';

test('inherited session bypasses disk, caches once and fails closed on invalid/expired input', async () => {
  for (const mode of ['valid', 'invalid', 'bad-fd']) {
    const child = spawn(process.execPath, ['--input-type=module'], {
      cwd: new URL('../../', import.meta.url),
      env: { OL_SESSION_FD: mode === 'bad-fd' ? 'invalid' : '3', OL_MCP_LOG_LEVEL: 'error' },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.stdio[3].on('error', () => {});
    child.stdio[3].end(mode === 'invalid' ? '{}' : JSON.stringify({
      baseUrl: 'https://www.overleaf.com', cookie: 'overleaf_session2=fixture',
    }));
    child.stdin.end(`
      import assert from 'node:assert/strict';
      import { promises as fs, fstatSync } from 'node:fs';
      import { loadStored, saveStored, clearStored } from './dist/auth/cookieStore.js';
      import { discoverCookie } from './dist/auth/discover.js';
      import { captureCookie } from './dist/auth/browserLogin.js';
      import { withAuthRetry } from './dist/session/recovery.js';
      import { OverleafAuthError } from './dist/api/errors.js';
      import './dist/api/socket.js'; // Load recovery's dynamic dependency before the disk guard.
      let disk = 0;
      fs.readFile = fs.writeFile = async () => { disk++; throw new Error('disk forbidden'); };
      const origin = 'https://www.overleaf.com';
      if (${JSON.stringify(mode)} === 'valid') {
        assert.equal((await loadStored(origin)).cookie, 'overleaf_session2=fixture');
        assert.throws(() => fstatSync(3), { code: 'EBADF' });
        assert.equal(await discoverCookie(origin), 'overleaf_session2=fixture');
        assert.equal(await discoverCookie(origin), 'overleaf_session2=fixture');
        await assert.rejects(loadStored('https://other.invalid'), /injected session/i);
        let calls = 0;
        await assert.rejects(withAuthRetry(async () => { calls++; throw new OverleafAuthError('expired'); }), /injected session/i);
        assert.equal(calls, 1);
      }
      await assert.rejects(discoverCookie(origin), /injected session/i);
      await assert.rejects(loadStored(origin), /injected session/i);
      await assert.rejects(saveStored(origin, 'fixture'), /injected session/i);
      await assert.rejects(clearStored(origin), /injected session/i);
      await assert.rejects(captureCookie(origin), /injected session/i);
      assert.equal(disk, 0);
    `);
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('FD smoke timed out')); }, 10000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(code, 0, `${mode}: ${output}`);
  }
});
