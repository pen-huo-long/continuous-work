import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

test('installed Host entry uses the exact package root required for Client discovery', async () => {
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8');
  const entryName = /name:\s*'([^']+)'/u.exec(patch)?.[1];
  assert.equal(entryName, manifest.name);
  assert.match(entryName, /^@[^/]+\/[^/]+$/u);
  assert.equal(require.resolve(entryName), fileURLToPath(new URL('index.js', root)));
  assert.equal(require.resolve(`${entryName}/client`), fileURLToPath(new URL('client.js', root)));
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
});

test('Client artifact registers the same root identity without evaluating its React factory', async () => {
  const source = await readFile(new URL('client.js', root), 'utf8');
  const registrations = [];
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (entry) => registrations.push(entry) } } });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, manifest.name);
  assert.equal(typeof registrations[0].factory, 'function');
});

test('plugin metadata and icon resolve through the installed package root', async () => {
  for (const locale of ['en', 'zh']) {
    const resource = require.resolve(`${manifest.name}/locale/${locale}.json`);
    const metadata = JSON.parse(await readFile(resource, 'utf8')).meta;
    assert.equal(metadata.title, 'Continuous work');
    assert.ok(metadata.description.length > 0);
  }
  const icon = await readFile(require.resolve(`${manifest.name}/icon`), 'utf8');
  assert.match(icon, /<svg\s/u);
  assert.ok(manifest.files.includes('client.js'));
  assert.ok(manifest.files.includes('cordis.patch.yml'));
});
