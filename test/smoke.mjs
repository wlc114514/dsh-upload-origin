import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test } from '../lib/index.js';

const root = await fs.mkdtemp(join(tmpdir(), 'dsh-upload-origin-'));
try {
  const original = join(root, 'sample.txt');
  await fs.writeFile(original, 'hello dsh\n');

  const bytes = await fs.readFile(original);
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const uploadDir = join(root, '.dsh-uploads', 'test');
  await fs.mkdir(uploadDir, { recursive: true });
  const uploaded = join(uploadDir, `${digest}-sample.txt`);
  await fs.copyFile(original, uploaded);

  const stat = await fs.stat(uploaded);
  const sha256 = await __test.sha256File(uploaded);
  const ctx = { get: () => undefined };
  const agent = { session: { id: 'test', header: { cwd: root } } };
  const result = await __test.resolveTarget(
    ctx,
    agent,
    {
      uploadPath: uploaded,
      name: 'sample.txt',
      size: stat.size,
      sha256,
      roots: [root],
    },
    { ...__test.DEFAULT_OPTIONS, maxSearchFiles: 1000, searchTimeoutMs: 5000 },
    undefined,
  );

  assert.equal(result.best_confidence, 'exact');
  assert.equal(result.best_path, original);
  console.log('smoke: ok');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
