/**
 * dsh-upload-origin — resolve the original local path of files uploaded to
 * `.dsh-uploads/`.
 *
 * Why this exists: the browser drag-and-drop upload surface (dsh-file-upload)
 * can only send file bytes and a file name; browsers do not expose the original
 * absolute path to JavaScript. The DSH host, however, runs on the same machine,
 * so this plugin scans the session workspace and common user folders and
 * matches the uploaded snapshot by file name + size + sha256. It then:
 *
 *   1. registers a `resolve_uploaded_file` tool for on-demand lookup; and
 *   2. injects an "uploaded file -> original path" block into the system prompt
 *      for the current agent, so the model knows the original path without the
 *      user having to type it.
 *
 * Host-only plugin: Node built-ins only, no external imports, no build step.
 */

import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const name = 'dsh-upload-origin';
export const inject = ['tools', 'systemPrompt'];

const UPLOAD_DIR_NAME = '.dsh-uploads';
const HASH_PREFIX = /^[0-9a-f]{16}-/i;
const TOOL_NAME = 'resolve_uploaded_file';
const PROMPT_SECTION_NAME = 'upload-origin:map';

const DEFAULT_OPTIONS = {
  /** Max filesystem entries visited during one original-path search. */
  maxSearchFiles: 250000,
  /** Search deadline for one original-path resolution. */
  searchTimeoutMs: 9000,
  /** Directory depth budget for common roots. */
  maxDepth: 12,
  /** Max candidate files whose content is hashed. */
  maxHashChecks: 30,
  /** Max candidates returned by the tool. */
  maxResults: 10,
  /** Only auto-resolve uploads newer than this. */
  recentUploadMs: 7 * 24 * 60 * 60 * 1000,
  /** Max recent uploads considered per prompt assembly. */
  maxRecentUploads: 8,
  /** Overall wait budget for the prompt-assembly mapping block. */
  autoResolveTimeoutMs: 7000,
};

/** Directories never traversed while looking for user documents. */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '$recycle.bin',
  'system volume information',
  'appdata',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '.dsh',
  '.dsh-uploads',
  '.cache',
  '.npm',
  '.pnpm-store',
  '.gradle',
  '.m2',
  '.venv',
  'venv',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
]);

const CONFIDENCE_RANK = {
  exact: 0,
  'name+size': 1,
  'name+size-hash-differs': 2,
  'name-only-size-differs': 3,
  'name-only': 4,
};

/** Per-upload resolution cache: uploadPath -> { size, mtimeMs, result?, promise? }. */
const uploadCache = new Map();

function log(...args) {
  try {
    console.log('[dsh-upload-origin]', ...args);
  } catch {}
}

function warn(...args) {
  try {
    console.warn('[dsh-upload-origin]', ...args);
  } catch {}
  log('WARN', ...args);
}

function pathKey(p) {
  const abs = resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function samePath(a, b) {
  if (!a || !b) return false;
  return pathKey(a) === pathKey(b);
}

function stripUploadHash(name) {
  return String(name || '').replace(HASH_PREFIX, '');
}

function sanitizeSessionId(id) {
  const cleaned = String(id || '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);
  return cleaned === '' ? 'anonymous' : cleaned;
}

function sessionOf(agent) {
  return agent && agent.session ? agent.session : undefined;
}

function sessionCwd(agent) {
  return sessionOf(agent)?.header?.cwd || process.cwd();
}

function sessionIdOf(agent) {
  const id = sessionOf(agent)?.id;
  return id === undefined || id === null ? '' : String(id);
}

function uploadDirFor(agent) {
  const id = sessionIdOf(agent);
  if (!id) return '';
  return join(sessionCwd(agent), UPLOAD_DIR_NAME, sanitizeSessionId(id));
}

function abortReason(signal, fallback = 'operation aborted') {
  if (signal && signal.reason !== undefined) return signal.reason;
  return new Error(fallback);
}

async function sha256File(filePath, signal) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath, signal ? { signal } : {});
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function statFile(filePath) {
  try {
    const st = await fsp.stat(filePath);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function shouldSkipDir(name) {
  if (typeof name !== 'string' || name === '') return true;
  if (name.startsWith('.')) return true;
  return SKIP_DIR_NAMES.has(name.toLowerCase());
}

function defaultRoots(agent) {
  const home = homedir();
  const cwd = sessionCwd(agent);
  const candidates = [
    { dir: cwd, maxDepth: 12 },
    { dir: join(home, 'Desktop'), maxDepth: 12 },
    { dir: join(home, 'Documents'), maxDepth: 12 },
    { dir: join(home, 'Downloads'), maxDepth: 12 },
    { dir: join(home, 'OneDrive', 'Desktop'), maxDepth: 12 },
    { dir: join(home, 'OneDrive', 'Documents'), maxDepth: 12 },
    { dir: join(home, 'OneDrive'), maxDepth: 8 },
    { dir: home, maxDepth: 3 },
  ];
  const seen = new Set();
  const out = [];
  for (const item of candidates) {
    const abs = resolve(item.dir);
    const key = pathKey(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dir: abs, maxDepth: item.maxDepth });
  }
  return out;
}

function normalizeRoots(roots, agent, opts) {
  const input = Array.isArray(roots) && roots.length > 0
    ? roots.map((dir) => ({ dir, maxDepth: opts.maxDepth }))
    : defaultRoots(agent);
  const seen = new Set();
  const out = [];
  for (const item of input) {
    if (item === undefined || item === null) continue;
    const dir = typeof item === 'string' ? item : item.dir;
    if (typeof dir !== 'string' || dir.trim() === '') continue;
    const abs = resolve(dir);
    const key = pathKey(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    const maxDepth = Number.isInteger(item.maxDepth)
      ? item.maxDepth
      : Number.isInteger(item.depth)
        ? item.depth
        : opts.maxDepth;
    out.push({ dir: abs, maxDepth });
  }
  return out;
}

async function listRecentUploads(agent, opts) {
  const dir = uploadDirFor(agent);
  if (!dir) return [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(dir, entry.name);
    const st = await statFile(full);
    if (!st) continue;
    if (opts.recentUploadMs > 0 && Date.now() - st.mtimeMs > opts.recentUploadMs) continue;
    files.push({ path: full, name: entry.name, size: st.size, mtimeMs: st.mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, opts.maxRecentUploads);
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** Text of direct human prompts in this session, newest last. */
function collectDirectUserText(agent) {
  const session = sessionOf(agent);
  if (!session || typeof session.snapshotEvents !== 'function') return '';
  try {
    const events = session.snapshotEvents();
    const parts = [];
    for (const event of events) {
      if (!event || event.type !== 'user/message') continue;
      const message = event.data;
      if (!message || !message.source || message.source.kind !== 'user') continue;
      parts.push(messageText(message));
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

/**
 * Keep only uploads the user actually referenced in a human prompt. The client
 * inserts the uploaded file path (often as an @-reference), and the hash prefix
 * makes the basename unique, so a substring check on the basename is a reliable
 * and cheap match.
 */
function filterReferencedUploads(uploads, text) {
  if (!text) return [];
  const haystack = text.replace(/\\/g, '/');
  return uploads.filter((upload) => {
    const base = basename(upload.path);
    return haystack.includes(upload.path.replace(/\\/g, '/')) || haystack.includes(base);
  });
}

/**
 * Breadth-first filename search. Returns only name matches; hashing and
 * confidence scoring happen in inspectCandidate/resolveTarget.
 */
async function searchRoots(roots, targetName, opts, signal) {
  const targetLower = String(targetName || '').toLowerCase();
  const started = Date.now();
  const deadline = started + opts.searchTimeoutMs;
  const queue = roots.map((root) => ({ dir: root.dir, depth: 0, maxDepth: root.maxDepth }));
  const seenDirs = new Set();
  const matches = [];
  let scannedFiles = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (signal && signal.aborted) throw abortReason(signal);
    if (Date.now() > deadline || scannedFiles >= opts.maxSearchFiles) {
      truncated = true;
      break;
    }
    const item = queue.shift();
    if (!item) continue;
    const dirKey = pathKey(item.dir);
    if (seenDirs.has(dirKey)) continue;
    seenDirs.add(dirKey);

    let entries;
    try {
      entries = await fsp.readdir(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (signal && signal.aborted) throw abortReason(signal);
      if (scannedFiles >= opts.maxSearchFiles) {
        truncated = true;
        break;
      }
      scannedFiles += 1;
      const full = join(item.dir, entry.name);

      if (entry.isDirectory()) {
        if (item.depth >= item.maxDepth) continue;
        if (shouldSkipDir(entry.name)) continue;
        queue.push({ dir: full, depth: item.depth + 1, maxDepth: item.maxDepth });
      } else if (entry.isFile()) {
        if (entry.name.toLowerCase() !== targetLower) continue;
        const st = await statFile(full);
        if (!st) continue;
        matches.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
        if (matches.length >= Math.max(opts.maxHashChecks * 3, 20)) {
          truncated = true;
          break;
        }
      }
    }
  }

  return { matches, scannedFiles, truncated, elapsedMs: Date.now() - started };
}

async function inspectCandidate(filePath, target, opts, hashBudget, signal, source) {
  const st = await statFile(filePath);
  if (!st) return null;
  const candidate = {
    path: filePath,
    size: st.size,
    mtimeMs: st.mtimeMs,
    matchedBy: ['name'],
    confidence: 'name-only',
    source,
  };

  if (target.size !== null && target.size !== undefined && st.size === target.size) {
    candidate.matchedBy.push('size');
    candidate.confidence = 'name+size';
  }

  const canCheckHash =
    target.sha256 &&
    (target.size === null || target.size === undefined || st.size === target.size) &&
    hashBudget.count < hashBudget.max;

  if (canCheckHash) {
    hashBudget.count += 1;
    try {
      const digest = await sha256File(filePath, signal);
      candidate.sha256 = digest;
      if (digest === target.sha256) {
        candidate.matchedBy.push('sha256');
        candidate.confidence = 'exact';
      } else if (candidate.confidence === 'name+size') {
        candidate.confidence = 'name+size-hash-differs';
      } else {
        candidate.confidence = 'name-only-size-differs';
      }
    } catch {
      // keep the name/size confidence; hash is best-effort
    }
  } else if (
    target.size !== null &&
    target.size !== undefined &&
    st.size !== target.size
  ) {
    candidate.confidence = 'name-only-size-differs';
  }

  return candidate;
}

async function referencePaths(ctx, agent, targetName, signal) {
  let service;
  try {
    service = ctx.get('fileReferences');
  } catch {
    service = undefined;
  }
  if (!service || typeof service.list !== 'function' || !agent) return [];
  let list;
  try {
    const effectiveSignal = signal || new AbortController().signal;
    list = await service.list(agent, targetName, effectiveSignal);
  } catch {
    return [];
  }
  const cwd = sessionCwd(agent);
  const targetLower = String(targetName || '').toLowerCase();
  const out = [];
  for (const item of list || []) {
    if (!item || item.kind !== 'file') continue;
    const full = isAbsolute(item.path) ? item.path : resolve(cwd, item.path);
    if (basename(full).toLowerCase() !== targetLower) continue;
    out.push(full);
  }
  return out;
}

function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const ra = CONFIDENCE_RANK[a.confidence] ?? 9;
    const rb = CONFIDENCE_RANK[b.confidence] ?? 9;
    if (ra !== rb) return ra - rb;
    return (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || a.path.length - b.path.length;
  });
}

function resolutionMessage(best, candidates) {
  if (!best && candidates.length === 0) {
    return 'No original-path candidate was found in the session workspace or the common user folders. Call again with search_roots if the file lives elsewhere.';
  }
  if (best && best.confidence === 'exact') {
    return 'Exact original path found by name + size + sha256. Prefer this original path when the user refers to their local file.';
  }
  if (best && best.confidence === 'name+size') {
    return 'Candidate found by name + size. The sha256 was not checked or differs; confirm before editing.';
  }
  return 'Only same-name candidates were found; the original may have been modified or renamed. Verify before editing.';
}

async function resolveTarget(ctx, agent, target, opts, signal) {
  const started = Date.now();
  const targetName = String(target.name || '').trim();
  if (targetName === '') throw new Error('resolveTarget requires a file name');

  const roots = normalizeRoots(target.roots, agent, opts);
  const hashBudget = { count: 0, max: opts.maxHashChecks };
  const candidates = [];

  // 1) The official workspace file-reference index is the fastest path for
  //    files inside the session cwd.
  const refPaths = await referencePaths(ctx, agent, targetName, signal);
  for (const filePath of refPaths) {
    if (target.uploadPath && samePath(filePath, target.uploadPath)) continue;
    const candidate = await inspectCandidate(filePath, target, opts, hashBudget, signal, 'workspace-index');
    if (candidate) candidates.push(candidate);
  }

  // 2) Fall back to a bounded filesystem scan when the workspace index did
  //    not produce an exact match (or is unavailable). Roots are searched one
  //    at a time, best-first; the first root with an exact match ends the
  //    search instead of scanning every configured folder.
  let scan = { matches: [], scannedFiles: 0, truncated: false, elapsedMs: 0 };
  if (!candidates.some((c) => c.confidence === 'exact')) {
    const overallDeadline = started + opts.searchTimeoutMs;
    const aggregate = { matches: [], scannedFiles: 0, truncated: false, elapsedMs: 0 };
    for (const root of roots) {
      if (signal && signal.aborted) throw abortReason(signal);
      const remaining = overallDeadline - Date.now();
      if (remaining <= 0) {
        aggregate.truncated = true;
        break;
      }
      const rootScan = await searchRoots(
        [root],
        targetName,
        { ...opts, searchTimeoutMs: remaining },
        signal,
      );
      aggregate.scannedFiles += rootScan.scannedFiles;
      aggregate.elapsedMs += rootScan.elapsedMs;
      aggregate.truncated = aggregate.truncated || rootScan.truncated;
      for (const match of rootScan.matches) {
        if (target.uploadPath && samePath(match.path, target.uploadPath)) continue;
        if (candidates.some((c) => samePath(c.path, match.path))) continue;
        const candidate = await inspectCandidate(match.path, target, opts, hashBudget, signal, 'filesystem-scan');
        if (candidate) candidates.push(candidate);
      }
      if (candidates.some((c) => c.confidence === 'exact')) break;
    }
    scan = aggregate;
  }

  const ranked = rankCandidates(candidates).slice(0, opts.maxResults);
  const best =
    ranked.find((c) => c.confidence === 'exact') ||
    ranked.find((c) => c.confidence === 'name+size') ||
    ranked[0] ||
    null;

  return {
    uploaded_path: target.uploadPath || '',
    original_name: targetName,
    size: target.size === null || target.size === undefined ? 0 : target.size,
    sha256: target.sha256 || '',
    best_path: best ? best.path : '',
    best_confidence: best ? best.confidence : 'none',
    candidates: ranked.map((c) => ({
      path: c.path,
      size: c.size ?? 0,
      confidence: c.confidence || 'unknown',
      matched_by: Array.isArray(c.matchedBy) ? c.matchedBy : [],
      source: c.source || 'filesystem-scan',
    })),
    roots: roots.map((r) => r.dir),
    scanned_files: scan.scannedFiles ?? 0,
    hash_checked: hashBudget.count,
    truncated: (scan.truncated ?? false) && !(best && best.confidence === 'exact'),
    elapsed_ms: Date.now() - started,
    message: resolutionMessage(best, ranked),
  };
}

async function uploadedTargetFromPath(agent, rawPath, opts, signal) {
  const cwd = sessionCwd(agent);
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const st = await statFile(abs);
  if (!st) return null;
  const sha256 = await sha256File(abs, signal);
  return {
    uploadPath: abs,
    name: stripUploadHash(basename(abs)),
    size: st.size,
    sha256,
    roots: [],
  };
}

function emptyResult(message) {
  return {
    uploaded_path: '',
    original_name: '',
    size: 0,
    sha256: '',
    best_path: '',
    best_confidence: 'none',
    candidates: [],
    roots: [],
    scanned_files: 0,
    hash_checked: 0,
    truncated: false,
    elapsed_ms: 0,
    message,
  };
}

function renderResolution(value) {
  const lines = [];
  lines.push(value.best_path ? `Original path: ${value.best_path}` : 'Original path: (not found)');
  lines.push(`Confidence: ${value.best_confidence}`);
  if (value.uploaded_path) lines.push(`Uploaded path: ${value.uploaded_path}`);
  if (value.original_name) lines.push(`File name: ${value.original_name}`);
  if (value.size) lines.push(`Size: ${value.size}`);
  if (value.sha256) lines.push(`sha256: ${value.sha256.slice(0, 16)}...`);
  if (value.candidates.length > 0) {
    lines.push('Candidates:');
    for (const c of value.candidates) {
      lines.push(`- ${c.path} [${c.confidence}] (${(c.matched_by || []).join('+')}; ${c.source})`);
    }
  }
  lines.push(value.message);
  if (value.truncated) lines.push('Search was truncated by the file/time budget; narrow search_roots if needed.');
  return lines.join('\n');
}

function createTool(ctx, opts) {
  return {
    name: TOOL_NAME,
    description:
      'Resolve the original local path of a file uploaded to .dsh-uploads. Call this automatically when a user message contains a .dsh-uploads path. It matches the uploaded snapshot against local files by name, size, and sha256 and returns the best original path plus candidates.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'Uploaded file path (absolute, or relative to the session workspace). If omitted, the most recent upload is resolved.',
        },
        name: {
          type: 'string',
          description: 'Original file name to locate when no uploaded file path is available.',
        },
        search_roots: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional extra absolute directories to search.',
        },
        max_results: {
          type: 'integer',
          description: 'Maximum candidates to return (1-20, default 10).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          uploaded_path: { type: 'string' },
          original_name: { type: 'string' },
          size: { type: 'integer' },
          sha256: { type: 'string' },
          best_path: { type: 'string' },
          best_confidence: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                size: { type: 'integer' },
                confidence: { type: 'string' },
                matched_by: { type: 'array', items: { type: 'string' } },
                source: { type: 'string' },
              },
              required: ['path', 'size', 'confidence', 'matched_by', 'source'],
            },
          },
          roots: { type: 'array', items: { type: 'string' } },
          scanned_files: { type: 'integer' },
          hash_checked: { type: 'integer' },
          truncated: { type: 'boolean' },
          elapsed_ms: { type: 'integer' },
          message: { type: 'string' },
        },
        required: [
          'uploaded_path',
          'original_name',
          'size',
          'sha256',
          'best_path',
          'best_confidence',
          'candidates',
          'roots',
          'scanned_files',
          'hash_checked',
          'truncated',
          'elapsed_ms',
          'message',
        ],
      },
      render: (_args, value) => [{ type: 'text', text: renderResolution(value) }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {};
      const signal = exec && exec.signal ? exec.signal : undefined;
      const agent = exec && exec.agent ? exec.agent : undefined;

      let filePath = typeof input.file_path === 'string' ? input.file_path.trim() : '';
      let targetName = typeof input.name === 'string' ? input.name.trim() : '';
      const searchRootsInput = Array.isArray(input.search_roots)
        ? input.search_roots.filter((s) => typeof s === 'string' && s.trim() !== '').slice(0, 20)
        : [];
      const maxResults =
        Number.isInteger(input.max_results) && input.max_results > 0
          ? Math.min(20, input.max_results)
          : opts.maxResults;

      const localOpts = { ...opts, maxResults };

      let target = null;
      if (filePath) {
        target = await uploadedTargetFromPath(agent, filePath, localOpts, signal);
        if (!target) targetName = targetName || basename(filePath);
      }

      if (!target && targetName) {
        target = {
          uploadPath: '',
          name: targetName,
          size: undefined,
          sha256: undefined,
          roots: searchRootsInput,
        };
      }

      if (!target) {
        const recent = await listRecentUploads(agent, localOpts);
        if (recent.length === 0) {
          return emptyResult(
            'No uploaded file path or name was provided, and no recent uploads were found for this session.',
          );
        }
        const first = recent[0];
        const sha256 = await sha256File(first.path, signal);
        target = {
          uploadPath: first.path,
          name: stripUploadHash(first.name),
          size: first.size,
          sha256,
          roots: searchRootsInput,
        };
      }

      if (searchRootsInput.length > 0) target.roots = searchRootsInput;
      return await resolveTarget(ctx, agent, target, localOpts, signal);
    },
  };
}

function timeoutToken() {
  return { __dshUploadOriginTimeout: true };
}

function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise;
  const token = timeoutToken();
  let timer;
  const timeout = new Promise((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(token), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function getOrStartResolution(ctx, agent, upload, opts) {
  const cached = uploadCache.get(upload.path);
  if (cached && cached.size === upload.size && cached.mtimeMs === upload.mtimeMs) {
    return cached.promise || Promise.resolve(cached.result);
  }

  const promise = (async () => {
    const sha256 = await sha256File(upload.path);
    const target = {
      uploadPath: upload.path,
      name: stripUploadHash(upload.name),
      size: upload.size,
      sha256,
      roots: [],
    };
    return await resolveTarget(ctx, agent, target, opts, undefined);
  })()
    .then((result) => {
      uploadCache.set(upload.path, { size: upload.size, mtimeMs: upload.mtimeMs, result });
      return result;
    })
    .catch((error) => {
      const result = emptyResult(`Failed to resolve original path: ${error && error.message ? error.message : String(error)}`);
      result.uploaded_path = upload.path;
      result.original_name = stripUploadHash(upload.name);
      result.size = upload.size;
      uploadCache.set(upload.path, { size: upload.size, mtimeMs: upload.mtimeMs, result });
      return result;
    });

  uploadCache.set(upload.path, { size: upload.size, mtimeMs: upload.mtimeMs, promise });
  return promise;
}

async function buildMappingBlock(ctx, agent, opts) {
  const recentUploads = await listRecentUploads(agent, opts);
  if (recentUploads.length === 0) return '';
  const userText = collectDirectUserText(agent);
  const uploads = filterReferencedUploads(recentUploads, userText);
  if (uploads.length === 0) return '';

  const lines = ['[Uploaded files: original local paths]'];
  let meaningful = false;
  const token = timeoutToken();
  const resolved = await Promise.all(
    uploads.map(async (upload) => {
      try {
        const result = await withTimeout(
          getOrStartResolution(ctx, agent, upload, opts),
          opts.autoResolveTimeoutMs,
        );
        return { upload, result };
      } catch (error) {
        const result = emptyResult(
          `Failed to resolve original path: ${error && error.message ? error.message : String(error)}`,
        );
        result.uploaded_path = upload.path;
        return { upload, result };
      }
    }),
  );

  for (const { upload, result } of resolved) {
    if (result === token) {
      lines.push(`- uploaded: ${upload.path}`);
      lines.push('  original: still resolving; call resolve_uploaded_file with this path to get it now.');
      meaningful = true;
      continue;
    }

    const bestPath = result && result.best_path ? result.best_path : '';
    const bestConfidence = result && result.best_confidence ? result.best_confidence : 'none';
    const candidates = result && Array.isArray(result.candidates) ? result.candidates : [];

    if (bestPath && (bestConfidence === 'exact' || bestConfidence === 'name+size')) {
      lines.push(`- uploaded: ${upload.path}`);
      lines.push(`  original: ${bestPath} [${bestConfidence}]`);
      lines.push('  Prefer this original path when the user refers to their local file; the .dsh-uploads copy is a snapshot.');
      meaningful = true;
    } else if (bestPath || candidates.length > 0) {
      const candidate = bestPath || candidates[0].path;
      const confidence = bestPath ? bestConfidence : candidates[0].confidence;
      lines.push(`- uploaded: ${upload.path}`);
      lines.push(`  likely original: ${candidate} [${confidence}]; call resolve_uploaded_file to confirm.`);
      meaningful = true;
    } else {
      lines.push(`- uploaded: ${upload.path}`);
      lines.push('  original: not found in the scanned folders; call resolve_uploaded_file with search_roots if needed.');
      meaningful = true;
    }
  }

  if (!meaningful) return '';
  lines.push(
    'When a user message contains a .dsh-uploads path, use the original path above when the user means their local file. Call resolve_uploaded_file if the mapping is missing or only a candidate.',
  );
  return lines.join('\n');
}

export function apply(ctx, config = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...(config && typeof config === 'object' ? config : {}) };

  ctx.effect(
    () => ctx.tools.register(createTool(ctx, opts)),
    'dsh-upload-origin: resolve_uploaded_file',
  );

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'tool:resolve-uploaded-file',
        order: 116,
        text:
          'When a user message contains a path under `.dsh-uploads/` (an uploaded attachment), call `resolve_uploaded_file` with that path before reading or editing the file. The tool resolves the original local path by matching name, size, and sha256. Prefer the original path when the user refers to their local file; the `.dsh-uploads` copy is a read-only snapshot.',
      }),
    'dsh-upload-origin: resolve tool guidance',
  );

  ctx.effect(
    () =>
      ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembled = await next();
        try {
          const agent = context && context.agent ? context.agent : undefined;
          if (!agent || !agent.session) return assembled;
          const block = await buildMappingBlock(ctx, agent, opts);
          if (!block) return assembled;
          const sections = Array.isArray(assembled.sections)
            ? assembled.sections.filter((section) => section && section.name !== PROMPT_SECTION_NAME)
            : [];
          sections.push({ name: PROMPT_SECTION_NAME, text: block });
          return { ...assembled, sections };
        } catch (error) {
          warn('system prompt mapping failed:', error && error.stack ? error.stack : String(error));
          return assembled;
        }
      }),
    'dsh-upload-origin: prompt mapping',
  );

  log('plugin applied: tool + prompt mapping registered');
}

/** Test-only exports: not used by the plugin loader. */
export const __test = {
  DEFAULT_OPTIONS,
  stripUploadHash,
  sanitizeSessionId,
  defaultRoots,
  normalizeRoots,
  searchRoots,
  inspectCandidate,
  referencePaths,
  rankCandidates,
  resolveTarget,
  sha256File,
};
