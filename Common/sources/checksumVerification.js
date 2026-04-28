/*
 * (c) Copyright Ascensio System SIA 2010-2024
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation. In accordance with
 * Section 7(a) of the GNU AGPL its Section 15 shall be amended to the effect
 * that Ascensio System SIA expressly excludes the warranty of non-infringement
 * of any third-party rights.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR  PURPOSE. For
 * details, see the GNU AGPL at: http://www.gnu.org/licenses/agpl-3.0.html
 *
 * You can contact Ascensio System SIA at 20A-6 Ernesta Birznieka-Upish
 * street, Riga, Latvia, EU, LV-1050.
 *
 * The  interactive user interfaces in modified source and object code versions
 * of the Program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU AGPL version 3.
 *
 * Pursuant to Section 7(b) of the License you must retain the original Product
 * logo when distributing the program. Pursuant to Section 7(e) we decline to
 * grant you any rights under trademark law for use of our trademarks.
 *
 * All the Product's GUI elements, including illustrations and icon sets, as
 * well as technical writing content are licensed under the terms of the
 * Creative Commons Attribution-ShareAlike 4.0 International. See the License
 * terms at http://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 */

'use strict';

const crypto = require('crypto');
const {Transform} = require('stream');

/**
 * @typedef {Object} OperationContext
 * @property {Object} logger - Logger instance with debug/info/warn/error methods
 * @property {Function} getCfg - Get configuration value
 * @property {Function} initFromRequest - Initialize from request
 * @property {Function} initTenantCache - Initialize tenant cache
 */

/**
 * Parse HTTP Digest header format (RFC 9530)
 * Handles parameters after semicolon (e.g., "sha-256=:abc:;foo=bar")
 *
 * @note This parser is practical and sufficient for real-world servers.
 *       For strict RFC 9530 Structured Fields compliance, consider using
 *       a library like httpbis-digest-headers in the future.
 *
 * @param {string} digestHeader - Digest or Repr-Digest header value
 * @returns {Object<string, string>} Object mapping algorithm names (lowercase) to base64 values
 */
function parseDigestDict(digestHeader) {
  const result = {};
  if (!digestHeader) {
    return result;
  }

  // Split by comma, handle multiple digests
  const items = digestHeader
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  for (const item of items) {
    // Drop parameters like ;foo=bar (RFC 9530 allows parameters)
    const [kv] = item.split(';', 1);

    // Format: algorithm=base64value or algorithm=:base64value:
    const match = kv.match(/^([a-z0-9-]+)=:?([A-Za-z0-9+/=]+):?$/i);
    if (match) {
      const alg = match[1].toLowerCase(); // Normalize algorithm name
      const b64 = match[2];
      result[alg] = b64;
    }
  }
  return result;
}

/**
 * Normalize x-goog-hash header to digest format
 * @param {string} xGoogHash - x-goog-hash header value (e.g., "crc32c=AAAAAA==,md5=1B2M2Y8AsgTpgAmY7PhCfg==")
 * @returns {string} Normalized format for parseDigestDict
 *
 * @note GCS typically returns crc32c and md5, rarely sha256. This function is provided for completeness.
 *
 * @future To fully utilize GCS checksums, consider adding parallel hash transforms for md5/crc32c
 *         and verify against those when sha256 is not available from the server.
 */
function normalizeXGoogHash(xGoogHash) {
  if (!xGoogHash) {
    return '';
  }
  // x-goog-hash already in compatible format: "alg=base64,alg=base64"
  return xGoogHash;
}

/**
 * Extract and verify checksums from HTTP response
 * @param {Object} headers - Response headers (lowercase keys)
 * @param {Object} trailers - Response trailers (lowercase keys, if any)
 * @param {string|Object} actualHashes - Actual hashes (SHA-256 base64 string or object {sha256, md5})
 * @param {OperationContext} ctx - Operation context for logging
 * @param {boolean} [opt_dataIsDecoded=true] - Whether the actual hashes were calculated from decoded (decompressed) data
 * @returns {{expected: string|null, actual: string, verified: boolean|null, source: string|null, algorithm: string|null}} Verification result
 */
function verifyResponseChecksum(headers, trailers, actualHashes, ctx, opt_dataIsDecoded = true) {
  const encoding = (headers['content-encoding'] || '').toLowerCase();
  const hasContentEncoding = !!encoding && encoding !== 'identity';
  // If data is NOT decoded (we have raw bytes), we can check checksums that apply to the encoded form (Content-MD5, Content-Digest).
  // If data IS decoded (Axios default), we can only check Repr-Digest.
  const canCheckEncoded = !hasContentEncoding || !opt_dataIsDecoded;

  // Handle input formats
  const actualSha256B64 = typeof actualHashes === 'string' ? actualHashes : actualHashes.sha256;
  const actualMd5B64 = typeof actualHashes === 'object' ? actualHashes.md5 : null;

  // Parse digest headers (headers are lowercase in Node.js)
  const contentDigest = parseDigestDict(headers['content-digest']);
  const reprDigest = parseDigestDict(headers['repr-digest']);

  // Parse trailers (always lowercase in Node.js)
  const trailerContentDigest = parseDigestDict(trailers?.['content-digest']);
  const trailerReprDigest = parseDigestDict(trailers?.['repr-digest']);

  // S3 checksum headers
  const s3Sha256 = headers['x-amz-checksum-sha256'];

  // Content-MD5 (RFC 1864) - base64 encoded
  const contentMd5 = headers['content-md5'];

  // Digest (RFC 3230) - Legacy standard (obsoleted by RFC 9530 but common)
  // Format: "SHA-256=... , MD5=..."
  const digest = parseDigestDict(headers['digest']);

  // ETag - Common fallback for S3/GCS/Azure/MinIO static files
  // Often contains MD5 hex (sometimes wrapped in quotes)
  let etagMd5 = null;
  const etag = headers['etag'];
  if (etag) {
    const cleanEtag = etag.replace(/^"|"$/g, ''); // Strip quotes
    // Check if it is a valid MD5 hex string (32 chars)
    // Note: S3 multipart ETags have a suffix (e.g. -1), we skip those
    if (/^[a-fA-F0-9]{32}$/.test(cleanEtag)) {
      // Convert hex to base64 for consistent comparison
      etagMd5 = Buffer.from(cleanEtag, 'hex').toString('base64');
    }
  }

  // GCS checksum headers (typically crc32c and md5, rarely sha256)
  const gcsHashes = parseDigestDict(normalizeXGoogHash(headers['x-goog-hash'] || ''));
  const gcsSha256 = gcsHashes['sha256'];
  const gcsMd5 = gcsHashes['md5'];

  // Priority-based expected value selection
  let expected = null;
  let source = null;
  let actual = actualSha256B64;
  let algorithm = 'sha-256';

  // Priority order based on RFC 9530 and best practices
  // Repr-Digest always applies to the decoded data (Representation)
  // Content-Digest applies to the encoded data (Content)

  // 1. Repr-Digest (RFC 9530) - Works if we have decoded data OR if there is no encoding
  // If we have raw compressed data (!opt_dataIsDecoded), we technically can't verify Repr-Digest easily
  // unless the encoding is identity. But for now, we assume Repr-Digest is primary if data matches.
  if (opt_dataIsDecoded && reprDigest['sha-256']) {
    expected = reprDigest['sha-256'];
    source = 'Repr-Digest';
  } else if (opt_dataIsDecoded && trailerReprDigest['sha-256']) {
    expected = trailerReprDigest['sha-256'];
    source = 'Trailer Repr-Digest';

    // 2. Content-Digest (RFC 9530) - Works if we check encoded data
  } else if (canCheckEncoded && contentDigest['sha-256']) {
    expected = contentDigest['sha-256'];
    source = 'Content-Digest';
  } else if (canCheckEncoded && trailerContentDigest['sha-256']) {
    expected = trailerContentDigest['sha-256'];
    source = 'Trailer Content-Digest';

    // 3. Vendor specifics
  } else if (s3Sha256) {
    expected = s3Sha256;
    source = 'x-amz-checksum-sha256';
  } else if (gcsSha256) {
    expected = gcsSha256;
    source = 'x-goog-hash sha256';

    // 4. Legacy Digests (RFC 3230)
  } else if (canCheckEncoded && digest['sha-256']) {
    expected = digest['sha-256'];
    source = 'Digest (RFC 3230) sha-256';

    // 5. MD5-based checks (Content-MD5, Digest MD5, ETag)
  } else if (canCheckEncoded && contentMd5 && actualMd5B64) {
    expected = contentMd5;
    source = 'Content-MD5';
    actual = actualMd5B64;
    algorithm = 'md5';
  } else if (canCheckEncoded && digest['md5'] && actualMd5B64) {
    expected = digest['md5'];
    source = 'Digest (RFC 3230) md5';
    actual = actualMd5B64;
    algorithm = 'md5';
  } else if (canCheckEncoded && gcsMd5 && actualMd5B64) {
    expected = gcsMd5;
    source = 'x-goog-hash md5';
    actual = actualMd5B64;
    algorithm = 'md5';
  } else if (canCheckEncoded && etagMd5 && actualMd5B64) {
    expected = etagMd5;
    source = 'ETag (MD5)';
    actual = actualMd5B64;
    algorithm = 'md5';
  }

  let verified = null;

  if (expected) {
    verified = expected === actual;
    ctx.logger.debug(
      'verifyResponseChecksum: source=%s expected=%s actual=%s verified=%s encoding=%s algorithm=%s',
      source,
      expected,
      actual,
      verified,
      encoding || 'none',
      algorithm
    );
  } else {
    ctx.logger.debug('verifyResponseChecksum: no checksum available from server');
  }

  return {
    expected,
    actual,
    verified,
    source,
    algorithm: expected ? algorithm : null
  };
}

/**
 * Transform stream that calculates SHA-256 and MD5 hashes while passing data through
 * Hashes can only be retrieved once after stream completes via getHashes()
 */
class HashTransform extends Transform {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.validate=false] - Whether to perform validation on end
   * @param {Object} [options.headers] - Response headers for validation
   * @param {Object} [options.response] - Response object (for trailers)
   * @param {OperationContext} [options.ctx] - Context for logging
   */
  constructor(options = {}) {
    super();
    this.sha256 = crypto.createHash('sha256');
    this.md5 = crypto.createHash('md5');
    this._finalized = false;
    this._hashes = null;

    // Validation options
    this.validate = options.validate || false;
    this.headers = options.headers;
    this.response = options.response;
    this.ctx = options.ctx;
    this.bytesReceived = 0;
  }

  /**
   * Transform implementation that updates hashes with each chunk
   * @param {Buffer|string} chunk - The chunk of data to process
   * @param {string} encoding - The encoding of the chunk if it's a string
   * @param {Function} callback - Called when processing is complete
   */
  _transform(chunk, encoding, callback) {
    if (this.sha256) {
      this.sha256.update(chunk);
    }
    if (this.md5) {
      this.md5.update(chunk);
    }
    this.bytesReceived += chunk.length;
    callback(null, chunk);
  }

  /**
   * Called when stream is finished
   * @param {Function} callback
   */
  _flush(callback) {
    if (!this.validate) {
      callback();
      return;
    }

    try {
      // 1. Validate Content-Length
      const encoding = (this.headers['content-encoding'] || '').toLowerCase();
      if (!encoding || encoding === 'identity') {
        const contentLength = this.headers['content-length'];
        if (contentLength && this.bytesReceived !== parseInt(contentLength, 10)) {
          const error = new Error('Content-Length mismatch: expected ' + contentLength + ', got ' + this.bytesReceived);
          error.code = 'E_CONTENT_LENGTH_MISMATCH';
          callback(error);
          return;
        }
      }

      // 2. Validate Checksum
      const hashes = this.getHashes(); // This finalizes the hash
      const trailers = this.response?.request?.res?.trailers || {};

      const verification = verifyResponseChecksum(this.headers, trailers, hashes, this.ctx);
      this._lastVerification = verification;

      if (verification.verified === false) {
        const error = new Error('Checksum mismatch: source=' + verification.source + ' algorithm=' + verification.algorithm);
        error.code = 'E_CHECKSUM_MISMATCH';
        callback(error);
        return;
      }

      callback();
    } catch (err) {
      callback(err);
    }
  }

  /**
   * Get the final hash values in base64 format
   * @returns {{sha256: string, md5: string}} Object containing hashes
   * @throws {Error} If called more than once or before stream completes (unless retrieved internally)
   */
  getHashes() {
    if (this._hashes) {
      return this._hashes;
    }

    if (this._finalized && !this._hashes) {
      // Should not happen if used correctly
      throw new Error('Hash already finalized but no result stored');
    }

    if (!this.sha256 || !this.md5) {
      // If logic flow is correct, this happens if getHashes called twice without _hashes cache
      // But we cache it now.
      throw new Error('Hash not initialized');
    }

    this._hashes = {
      sha256: this.sha256.digest('base64'),
      md5: this.md5.digest('base64')
    };

    this.sha256 = null;
    this.md5 = null;
    this._finalized = true;
    return this._hashes;
  }

  /**
   * Get SHA-256 hash for backward compatibility
   * @returns {string} SHA-256 hash in base64 format
   */
  getHash() {
    return this.getHashes().sha256;
  }
}

module.exports = {
  parseDigestDict,
  normalizeXGoogHash,
  verifyResponseChecksum,
  HashTransform
};
