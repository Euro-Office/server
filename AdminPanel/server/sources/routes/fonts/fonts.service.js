'use strict';
const childProcess = require('child_process');
const config = require('config');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {Worker} = require('worker_threads');

const operationContext = require('../../../../../Common/sources/operationContext');

const cfgCustomFontsDir = config.get('adminPanel.fonts.customFontsDir');
const cfgRegenerateCommand = config.get('adminPanel.fonts.regenerateCommand');

// Extensions the converter searches for (utils_fonts_search_patterns: *.ttf;*.ttc;*.otf)
const allowedExtensions = new Set(['.ttf', '.otf', '.ttc']);
// sfnt magic bytes: TTF (00 01 00 00 / 'true'), OTF ('OTTO'), TTC ('ttcf')
const fontMagics = [Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from('true'), Buffer.from('OTTO'), Buffer.from('ttcf')];

const fontParserWorkerPath = path.join(__dirname, 'fontParser.worker.js');
// A pathological font can make fontkit hang or spin forever; only killing the thread
// it runs on actually stops that, so parsing happens off-thread with a hard deadline.
const fontParseTimeoutMs = 5000;

/**
 * Parse a font in an isolated, killable worker thread so a malicious or pathological
 * font file can never hang or crash the main event loop.
 * @param {{mode: 'path', filePath: string}|{mode: 'buffer', buffer: Buffer}} task what to parse
 * @returns {Promise<{family: string, subfamily: string, fullName: string, postscriptName: string}>} font descriptor
 */
function parseFontInWorker(task) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fontParserWorkerPath, {workerData: task});
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      fn(arg);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`font parsing timed out after ${fontParseTimeoutMs}ms`));
    }, fontParseTimeoutMs);
    worker.once('message', msg => {
      finish(msg.ok ? resolve : reject, msg.ok ? msg.result : new Error(msg.error));
    });
    worker.once('error', err => finish(reject, err));
    worker.once('exit', code => finish(reject, new Error(`font parser worker exited unexpectedly (code ${code})`)));
  });
}

class FontValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'FontValidationError';
    this.details = details;
  }
}

function getCustomFontsDir() {
  if (cfgCustomFontsDir) {
    // Absolute stays as-is; relative (dev configs) resolves against the service cwd
    return path.resolve(cfgCustomFontsDir);
  }
  // Derived default: <ds-root>/../Data/custom-fonts.
  // Under pkg the binary sits at <ds-root>/server/AdminPanel/server/adminpanel;
  // __dirname would point into pkg's /snapshot, so use execPath there.
  const dsRoot = process.pkg ? path.resolve(path.dirname(process.execPath), '../../..') : path.resolve(__dirname, '../../../../../..');
  return path.join(dsRoot, '..', 'Data', 'custom-fonts');
}

async function getFontName(filePath) {
  const descriptor = await parseFontInWorker({mode: 'path', filePath});
  return {file: path.basename(filePath), ...descriptor};
}

/**
 * @returns {Promise<Array<object>>} descriptors for every font in the custom fonts directory
 */
function listFonts() {
  const dir = getCustomFontsDir();
  const files = fs.readdirSync(dir).filter(f => allowedExtensions.has(path.extname(f).toLowerCase()));
  return Promise.all(files.map(f => getFontName(path.join(dir, f))));
}

/**
 * Validate a font filename (upload target or delete argument)
 * @param {string} rawName filename as received from the client
 * @returns {{name: string}|{error: string}} sanitized filename or rejection reason
 */
function validateFontFileName(rawName) {
  const name = typeof rawName === 'string' ? rawName.normalize('NFC') : '';
  if (!name || name !== path.basename(name) || name.includes('/') || name.includes('\\')) {
    return {error: 'filename must not contain path separators'};
  }
  if (name.startsWith('.')) {
    return {error: 'filename must not start with a dot'};
  }
  if (name.includes('..')) {
    return {error: 'filename must not contain ".."'};
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001F\u007F]/.test(name)) {
    return {error: 'filename must not contain control characters'};
  }
  if (!allowedExtensions.has(path.extname(name).toLowerCase())) {
    return {error: 'unsupported extension (allowed: .ttf, .otf, .ttc)'};
  }
  return {name};
}

/**
 * Validate one uploaded font file (multer memory-storage shape)
 * @param {{originalname: string, buffer: Buffer}} file uploaded file
 * @returns {{name: string}|{error: string}} sanitized filename or rejection reason
 */
async function validateFontFile(file) {
  const {name, error} = validateFontFileName(file.originalname);
  if (error) {
    return {error};
  }
  const buffer = file.buffer;
  if (!buffer || buffer.length < 4 || !fontMagics.some(magic => magic.equals(buffer.subarray(0, 4)))) {
    return {error: 'not a recognized font file (TTF/OTF/TTC)'};
  }
  try {
    await parseFontInWorker({mode: 'buffer', buffer});
  } catch (err) {
    return {error: `font file could not be parsed: ${err.message}`};
  }
  return {name};
}

/**
 * Validate and store uploaded fonts into the custom fonts directory.
 * All files are validated before any is written (all-or-nothing).
 * @param {Array<{originalname: string, buffer: Buffer}>} files uploaded files
 * @returns {Promise<Array<{file: string, size: number, replaced: boolean}>>} stored files
 * @throws {FontValidationError} with per-file details when any file is rejected
 */
async function saveFonts(files) {
  const dir = getCustomFontsDir();
  const rejected = [];
  const accepted = [];
  const results = await Promise.all(files.map(file => validateFontFile(file)));
  results.forEach(({name, error}, i) => {
    if (error) {
      rejected.push({file: files[i].originalname, error});
    } else {
      accepted.push({name, buffer: files[i].buffer});
    }
  });
  if (rejected.length > 0) {
    throw new FontValidationError('one or more font files were rejected', rejected);
  }

  await fs.promises.mkdir(dir, {recursive: true});
  const saved = [];
  for (const {name, buffer} of accepted) {
    const finalPath = path.resolve(dir, name);
    if (path.dirname(finalPath) !== dir) {
      throw new FontValidationError('one or more font files were rejected', [{file: name, error: 'resolves outside the custom fonts directory'}]);
    }
    const replaced = fs.existsSync(finalPath);
    // Temp file + rename so a half-written font can never be picked up by a concurrent regeneration
    const tmpPath = path.join(dir, `.${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      await fs.promises.writeFile(tmpPath, buffer, {mode: 0o644});
      await fs.promises.rename(tmpPath, finalPath);
    } catch (err) {
      await fs.promises.rm(tmpPath, {force: true});
      throw err;
    }
    saved.push({file: name, size: buffer.length, replaced});
  }
  return saved;
}

/**
 * Delete one custom font file.
 * @param {string} filename filename as received from the client
 * @returns {Promise<string>} the deleted (sanitized) filename
 * @throws {FontValidationError} when the filename is rejected
 * @throws {Error} with code ENOENT when the file does not exist
 */
async function deleteFont(filename) {
  const {name, error} = validateFontFileName(filename);
  if (error) {
    throw new FontValidationError(error, [{file: filename, error}]);
  }
  const dir = getCustomFontsDir();
  const finalPath = path.resolve(dir, name);
  if (path.dirname(finalPath) !== dir) {
    throw new FontValidationError('resolves outside the custom fonts directory', [
      {file: name, error: 'resolves outside the custom fonts directory'}
    ]);
  }
  await fs.promises.unlink(finalPath);
  return name;
}

class RegenerationRunningError extends Error {
  constructor() {
    super('a font regeneration is already running');
    this.name = 'RegenerationRunningError';
  }
}

class RegenerationUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegenerationUnavailableError';
  }
}

// Keep only the tail of the script output: enough for diagnostics, bounded in memory
const regenOutputTailBytes = 8192;
// Single-flight, in-process job state. The AdminPanel is a single-process service
// and is not restarted by the regeneration script, so this survives to be polled.
const regenState = {
  status: 'idle', // idle | running | done | failed
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  outputTail: ''
};

/**
 * Current regeneration job status for API responses.
 * @returns {{status: string, startedAt: ?string, finishedAt: ?string, exitCode: ?number, outputTail: string|undefined}} status snapshot
 */
function getRegenerationStatus() {
  const status = {
    status: regenState.status,
    startedAt: regenState.startedAt,
    finishedAt: regenState.finishedAt
  };
  if ('failed' === regenState.status) {
    status.exitCode = regenState.exitCode;
    status.outputTail = regenState.outputTail;
  }
  return status;
}

/**
 * Fail fast when the configured command cannot possibly run, so the endpoint can
 * answer 501 with remediation instead of leaving a doomed job to fail asynchronously.
 * @param {string[]} argv parsed regenerate command
 * @returns {Promise<void>} resolves when the command looks runnable
 * @throws {RegenerationUnavailableError} when sudo denies the command or the binary is missing
 */
async function assertRegenerationAvailable(argv) {
  const remediation =
    'install the sudoers rule allowing the service user to run the script without a password, or point adminPanel.fonts.regenerateCommand at a runnable command';
  if ('sudo' === argv[0]) {
    // 'sudo -n -l <cmd>' asks non-interactively whether the current user may run <cmd>
    const command = argv.slice(1).filter(arg => !arg.startsWith('-'));
    await new Promise((resolve, reject) => {
      childProcess.execFile('sudo', ['-n', '-l', ...command], {timeout: 10000}, (err, stdout, stderr) => {
        if (err) {
          reject(
            new RegenerationUnavailableError(`regeneration is not permitted for this service (${stderr.trim() || err.message}); ${remediation}`)
          );
        } else {
          resolve();
        }
      });
    });
  } else if (path.isAbsolute(argv[0])) {
    try {
      await fs.promises.access(argv[0], fs.constants.X_OK);
    } catch {
      throw new RegenerationUnavailableError(`${argv[0]} is not executable; ${remediation}`);
    }
  }
}

/**
 * Start the font regeneration script in the background (single-flight).
 * @returns {Promise<object>} status snapshot of the freshly started job
 * @throws {RegenerationRunningError} when a job is already running
 * @throws {RegenerationUnavailableError} when the configured command cannot run
 */
async function startRegeneration() {
  if ('running' === regenState.status) {
    throw new RegenerationRunningError();
  }
  // Fixed argv from config, no shell interpolation; nothing from the request reaches the command
  const argv = cfgRegenerateCommand.split(/\s+/).filter(Boolean);
  if (0 === argv.length) {
    throw new RegenerationUnavailableError('adminPanel.fonts.regenerateCommand is empty');
  }
  // Claim the slot before the first await so concurrent triggers get 409
  regenState.status = 'running';
  regenState.startedAt = new Date().toISOString();
  regenState.finishedAt = null;
  regenState.exitCode = null;
  regenState.outputTail = '';
  try {
    await assertRegenerationAvailable(argv);
  } catch (err) {
    regenState.status = 'failed';
    regenState.finishedAt = new Date().toISOString();
    regenState.outputTail = err.message;
    throw err;
  }

  const logger = operationContext.global.logger;
  logger.info('font regeneration started: %s', cfgRegenerateCommand);
  // spawn instead of execFile: allfontsgen logs every font it processes, which can
  // exceed execFile's buffer; we only keep a rolling tail
  const child = childProcess.spawn(argv[0], argv.slice(1), {stdio: ['ignore', 'pipe', 'pipe']});
  const appendOutput = chunk => {
    regenState.outputTail = (regenState.outputTail + chunk.toString()).slice(-regenOutputTailBytes);
  };
  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);
  const finish = (exitCode, err) => {
    if ('running' !== regenState.status) {
      return;
    }
    regenState.finishedAt = new Date().toISOString();
    regenState.exitCode = exitCode;
    if (err || 0 !== exitCode) {
      regenState.status = 'failed';
      if (err) {
        regenState.outputTail = (regenState.outputTail + err.message).slice(-regenOutputTailBytes);
      }
      logger.error('font regeneration failed (exit code %s): %s', exitCode, regenState.outputTail);
    } else {
      regenState.status = 'done';
      logger.info('font regeneration finished successfully');
    }
  };
  child.on('error', err => finish(null, err));
  child.on('close', code => finish(code));
  return getRegenerationStatus();
}

module.exports = {
  listFonts,
  saveFonts,
  deleteFont,
  startRegeneration,
  getRegenerationStatus,
  FontValidationError,
  RegenerationRunningError,
  RegenerationUnavailableError
};
