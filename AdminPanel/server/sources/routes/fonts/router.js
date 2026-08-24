/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH or an Nextcloud affiliate company and Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const jwt = require('jsonwebtoken');
const config = require('config');
const {validateJWT} = require('../../middleware/auth');
const operationContext = require('../../../../../Common/sources/operationContext');
const tenantManager = require('../../../../../Common/sources/tenantManager');
const cookieParser = require('cookie-parser');

const router = express.Router();
router.use(cookieParser());

// Block all font-management requests in multitenant mode.
// getCustomFontsDir() is a single unpartitioned path and the browser secret
// is shared across tenants, so neither auth path provides tenant isolation.
router.use((req, res, next) => {
  if (tenantManager.isMultitenantMode(operationContext.global)) {
    return res.status(403).json({error: 'Font management is not supported in multitenant mode'});
  }
  next();
});

// Supported font MIME types and magic byte signatures
const FONT_SIGNATURES = [
  {ext: '.ttf', magic: Buffer.from([0x00, 0x01, 0x00, 0x00])},
  {ext: '.otf', magic: Buffer.from([0x4f, 0x54, 0x54, 0x4f])},
  {ext: '.ttc', magic: Buffer.from([0x74, 0x74, 0x63, 0x66])},
  {ext: '.woff', magic: Buffer.from([0x77, 0x4f, 0x46, 0x46])},
  {ext: '.woff2', magic: Buffer.from([0x77, 0x4f, 0x46, 0x32])}
];

const ALLOWED_EXTENSIONS = new Set(FONT_SIGNATURES.map(s => s.ext));

// EO installation root — used for font dir resolution.
const EO_ROOT = process.env.EO_ROOT || '/var/www/euro-office/documentserver';

// Upload size limit — read from the same config key used by DocService and the config router.
const cfgUploadLimit = config.get('services.CoAuthoring.server.limits_tempfile_upload');

/**
 * Auth middleware that accepts either:
 *   (a) AdminPanel cookie JWT  (browser admin login), or
 *   (b) Authorization: Bearer <token> signed with the DS JWT secret  (server-to-server,
 *       used by the Nextcloud connector's FontController).
 *
 * Bearer tokens MUST carry sub === 'font-api' and a finite exp claim to prevent
 * reuse of other DS-signed tokens (e.g. browser editing-session tokens).
 *
 * Note: config.get() is frozen at process start (config@3 makeImmutable).  Full
 * hot-rotation support for the browser secret requires wiring through ctx.getCfg().
 *
 * Multitenant mode is rejected at the router level (above) before this
 * middleware runs, so both auth paths are gated equally.
 */
const requireAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const secret = config.has('services.CoAuthoring.secret.browser.string') ? config.get('services.CoAuthoring.secret.browser.string') : '';
    if (!secret) {
      return res.status(401).json({error: 'Unauthorized'});
    }
    const token = authHeader.slice(7);
    try {
      const decoded = jwt.verify(token, secret, {algorithms: ['HS256']});
      if (decoded.sub !== 'font-api') {
        return res.status(403).json({error: 'Forbidden'});
      }
      if (!decoded.exp) {
        return res.status(401).json({error: 'Unauthorized'});
      }
      req.ctx = operationContext.global;
      return next();
    } catch {
      return res.status(401).json({error: 'Unauthorized'});
    }
  }
  // Fall back to AdminPanel cookie JWT
  return validateJWT(req, res, next);
};

/**
 * Same-origin guard for state-changing routes.
 * If the browser sends an Origin header (all cross-site and most same-site
 * requests), validate it matches the request host exactly.  Requests without
 * an Origin header (server-to-server bearer calls) are passed through.
 */
const requireSameOrigin = (req, res, next) => {
  const origin = req.headers['origin'];
  if (!origin) return next();
  try {
    const originHost = new URL(origin).host;
    if (originHost !== req.headers['host']) {
      return res.status(403).json({error: 'Forbidden'});
    }
  } catch {
    return res.status(403).json({error: 'Forbidden'});
  }
  return next();
};

/**
 * Resolve the custom-fonts directory from environment or default.
 */
function getCustomFontsDir() {
  return path.resolve(EO_ROOT, '..', 'Data', 'custom-fonts');
}

// Paths to the packaged helper scripts in the ds sudoers allowlist.
const ALLFONTS_SCRIPT = '/usr/bin/documentserver-generate-allfonts.sh';
const RESTART_SCRIPT = '/usr/bin/documentserver-restart.sh';
const FLUSH_CACHE_SCRIPT = '/usr/bin/documentserver-flush-cache.sh';

// Max bytes to buffer from child process stdout+stderr for diagnostics.
const OUTPUT_CAP = 4096;

// Per-step timeouts for the regeneration pipeline (ms).
const ALLFONTS_TIMEOUT = 5 * 60 * 1000; // allfontsgen can be slow for many fonts
const RESTART_TIMEOUT = 30 * 1000;
const FLUSH_CACHE_TIMEOUT = 30 * 1000;

// In-memory regeneration status (single-node only; sufficient for AdminPanel).
const regenStatus = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  error: null
};

/**
 * Validate a font file buffer by checking magic bytes.
 * @param {Buffer} buf
 * @returns {string|null} detected extension, or null if invalid
 */
function detectFontExtension(buf) {
  if (buf.length < 4) return null;
  for (const {ext, magic} of FONT_SIGNATURES) {
    if (buf.slice(0, magic.length).equals(magic)) return ext;
  }
  return null;
}

/**
 * Ensure the custom-fonts directory exists.
 * Throws if the parent Data directory is absent — a missing parent almost
 * certainly means the data volume is not mounted; creating the full path
 * there would silently write fonts to the wrong location.
 * @param {string} dir
 */
function ensureFontsDir(dir) {
  const parent = path.dirname(dir);
  if (!fs.existsSync(parent)) {
    throw new Error(`Data directory not found: ${parent} — is the data volume mounted?`);
  }
  fs.mkdirSync(dir, {recursive: true});
}

/**
 * Run a child process with a timeout, accumulating output up to OUTPUT_CAP.
 * Resolves on exit 0; rejects with a descriptive Error otherwise.
 * @param {string[]} args - [command, ...args]
 * @param {number} timeoutMs
 * @param {object} ctx - operation context for logging
 * @param {string} label - name used in log/error messages
 * @returns {Promise<void>}
 */
function runScript(args, timeoutMs, ctx, label) {
  return new Promise((resolve, reject) => {
    const [cmd, ...rest] = args;
    const proc = spawn(cmd, rest, {stdio: ['ignore', 'pipe', 'pipe'], detached: false});

    const chunks = [];
    let totalLen = 0;
    const appendChunk = chunk => {
      if (totalLen < OUTPUT_CAP) {
        chunks.push(chunk);
        totalLen += chunk.length;
      }
    };
    proc.stdout.on('data', appendChunk);
    proc.stderr.on('data', appendChunk);

    const timer = setTimeout(() => {
      // Note: sudo transitions its real UID to root, so SIGTERM from the
      // unprivileged ds process may not reach the script (EPERM).  The
      // promise rejects and the in-memory lock is released, but the
      // root-owned script may continue running until it exits naturally.
      // Overlapping runs after a timeout are therefore possible — acceptable
      // for this single-node, admin-only use case.
      proc.kill('SIGTERM');
      reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString('utf8');
      if (output) ctx.logger.debug('fonts regenerate %s output: %s', label, output.slice(0, OUTPUT_CAP));
      if (code !== 0) {
        reject(new Error(`${label} exited with code ${code}: ${output.slice(0, OUTPUT_CAP)}`));
      } else {
        resolve();
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`${label} spawn failed: ${err.message}`));
    });
  });
}

/**
 * GET /admin/api/v1/fonts
 * List custom fonts.
 */
router.get('/', requireAuth, (req, res) => {
  const ctx = req.ctx;
  try {
    const dir = getCustomFontsDir();
    if (!fs.existsSync(dir)) {
      return res.json({fonts: []});
    }
    const fonts = [];
    for (const name of fs.readdirSync(dir)) {
      if (!ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.lstatSync(full);
        if (!stat.isFile()) continue; // skip symlinks and directories
        fonts.push({name, size: stat.size, modifiedAt: stat.mtime.toISOString()});
      } catch {
        continue; // file disappeared between readdir and lstat — skip it
      }
    }
    res.json({fonts});
  } catch (err) {
    ctx.logger.error('fonts list error: %s', err.stack);
    res.status(500).json({error: 'Failed to list fonts'});
  }
});

/**
 * POST /admin/api/v1/fonts/regenerate
 * Trigger async font regeneration, service restart, and cache flush.
 *
 * Sequence (all via sudo, scripts are in the ds sudoers allowlist):
 *   1. documentserver-generate-allfonts.sh true  — regenerate font assets
 *   2. documentserver-restart.sh  — restart docservice + converter
 *   3. documentserver-flush-cache.sh  — rotate nginx cache tag
 *
 * Returns 202 immediately; poll GET /status for completion.
 */
router.post('/regenerate', requireAuth, requireSameOrigin, (req, res) => {
  const ctx = req.ctx;

  if (regenStatus.status === 'running') {
    return res.status(409).json({error: 'Regeneration already in progress', status: regenStatus});
  }

  regenStatus.status = 'running';
  regenStatus.startedAt = new Date().toISOString();
  regenStatus.finishedAt = null;
  regenStatus.error = null;

  res.status(202).json({message: 'Font regeneration started', status: regenStatus});

  (async () => {
    try {
      ctx.logger.info('fonts regenerate: starting allfontsgen');
      await runScript(['sudo', ALLFONTS_SCRIPT, 'true'], ALLFONTS_TIMEOUT, ctx, 'allfontsgen');

      ctx.logger.info('fonts regenerate: restarting services');
      await runScript(['sudo', RESTART_SCRIPT], RESTART_TIMEOUT, ctx, 'restart');

      ctx.logger.info('fonts regenerate: flushing cache');
      await runScript(['sudo', FLUSH_CACHE_SCRIPT], FLUSH_CACHE_TIMEOUT, ctx, 'flush-cache');

      regenStatus.status = 'done';
      regenStatus.finishedAt = new Date().toISOString();
      ctx.logger.info('fonts regenerate: completed successfully');
    } catch (err) {
      regenStatus.status = 'error';
      regenStatus.finishedAt = new Date().toISOString();
      regenStatus.error = err.message;
      ctx.logger.error('fonts regenerate failed: %s', err.message);
    }
  })();
});

/**
 * GET /admin/api/v1/fonts/status
 * Poll regeneration status.
 */
router.get('/status', requireAuth, (req, res) => {
  res.json(regenStatus);
});

/**
 * POST /admin/api/v1/fonts
 * Upload a single font file.
 * Expects:
 *   Content-Type: application/octet-stream
 *   X-Font-Name: <percent-encoded filename> (supported extension, max 255 bytes encoded)
 * Body: raw font file bytes
 *
 * The file is written to a temp path and renamed atomically to prevent
 * partial writes on crash or ENOSPC, and to avoid following symlinks at
 * the destination.
 */
router.post('/', requireAuth, requireSameOrigin, express.raw({type: 'application/octet-stream', limit: cfgUploadLimit}), (req, res) => {
  const ctx = req.ctx;
  try {
    // Reject wrong Content-Type before giving a confusing "empty body" error.
    const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/octet-stream') {
      return res.status(415).json({error: 'Content-Type must be application/octet-stream'});
    }

    const rawHeader = req.headers['x-font-name'] || '';
    if (rawHeader.length > 255) {
      return res.status(400).json({error: 'X-Font-Name exceeds 255 characters'});
    }

    // Take only the first value (Node joins duplicate headers with ', ').
    const firstValue = rawHeader.split(',')[0].trim();
    let decodedName;
    try {
      decodedName = decodeURIComponent(firstValue);
    } catch {
      return res.status(400).json({error: 'X-Font-Name is not valid percent-encoding'});
    }

    // path.basename strips any path traversal attempt.
    const safeName = path.basename(decodedName);
    if (!safeName) {
      return res.status(400).json({error: 'Missing or empty X-Font-Name header'});
    }

    // Reject control characters (including null bytes).  Path separators
    // are already stripped by path.basename() above.
    if (/\p{Cc}/u.test(safeName)) {
      return res.status(400).json({error: 'Font filename contains invalid characters'});
    }

    const ext = path.extname(safeName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return res.status(400).json({
        error: `Unsupported font format. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`
      });
    }

    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({error: 'Empty or missing font body'});
    }

    const detectedExt = detectFontExtension(buf);
    if (detectedExt === null) {
      return res.status(400).json({error: 'File does not appear to be a valid font (bad magic bytes)'});
    }
    if (detectedExt !== ext) {
      return res.status(400).json({
        error: `File extension does not match detected font type (${detectedExt})`
      });
    }

    const dir = getCustomFontsDir();
    ensureFontsDir(dir);

    // Write atomically: temp file + rename avoids partial writes and
    // does not follow a symlink at the destination.
    const dest = path.join(dir, safeName);
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, buf, {flag: 'wx'});
      fs.renameSync(tmp, dest);
    } catch (err) {
      fs.rmSync(tmp, {force: true});
      throw err;
    }

    ctx.logger.info('fonts upload: saved %s (%d bytes)', safeName, buf.length);
    res.status(201).json({name: safeName, size: buf.length});
  } catch (err) {
    ctx.logger.error('fonts upload error: %s', err.stack);
    res.status(500).json({error: 'Failed to save font'});
  }
});

/**
 * DELETE /admin/api/v1/fonts/:name
 * Delete a custom font by filename.
 */
router.delete('/:name', requireAuth, requireSameOrigin, (req, res) => {
  const ctx = req.ctx;
  try {
    // Express already decodes route params once; a second decodeURIComponent
    // would double-decode and make filenames with literal '%' undeletable.
    const safeName = path.basename(req.params.name);
    if (!safeName || /\p{Cc}/u.test(safeName)) {
      return res.status(400).json({error: 'Invalid font name'});
    }

    const ext = path.extname(safeName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return res.status(400).json({error: 'Not a font file'});
    }

    const target = path.join(getCustomFontsDir(), safeName);
    try {
      fs.unlinkSync(target);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({error: 'Font not found'});
      }
      throw err;
    }

    ctx.logger.info('fonts delete: removed %s', safeName);
    res.status(200).json({deleted: safeName});
  } catch (err) {
    ctx.logger.error('fonts delete error: %s', err.stack);
    res.status(500).json({error: 'Failed to delete font'});
  }
});

module.exports = router;
