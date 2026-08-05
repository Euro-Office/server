'use strict';
const {parentPort, workerData} = require('worker_threads');
const fontkit = require('fontkit');

// Fonts that are technically well-formed but structurally excessive are rejected here.
// sfnt numGlyphs/numTables are 16-bit fields; no legitimate font needs anywhere near these.
const maxTables = 64;
const maxGlyphs = 65536;
const maxCollectionFonts = 16;
const maxNameFieldLength = 256;

function truncateField(value) {
  return 'string' === typeof value && value.length > maxNameFieldLength ? value.slice(0, maxNameFieldLength) : value;
}

function describeAndValidate(font) {
  const numTables = font.directory ? font.directory.numTables : 0;
  if (numTables > maxTables) {
    throw new Error(`font declares too many tables (${numTables} > ${maxTables})`);
  }
  const numGlyphs = font.numGlyphs || 0;
  if (numGlyphs > maxGlyphs) {
    throw new Error(`font declares too many glyphs (${numGlyphs} > ${maxGlyphs})`);
  }
  return {
    family: truncateField(font.familyName),
    subfamily: truncateField(font.subfamilyName),
    fullName: truncateField(font.fullName),
    postscriptName: truncateField(font.postscriptName)
  };
}

function openFont() {
  const {mode, filePath, buffer} = workerData;
  const font = 'path' === mode ? fontkit.openSync(filePath) : fontkit.create(Buffer.from(buffer));
  if (Array.isArray(font.fonts)) {
    // TrueType/OpenType collection (.ttc): validate every embedded font, describe the first
    if (font.fonts.length > maxCollectionFonts) {
      throw new Error(`font collection has too many fonts (${font.fonts.length} > ${maxCollectionFonts})`);
    }
    return font.fonts.map(describeAndValidate)[0];
  }
  return describeAndValidate(font);
}

try {
  parentPort.postMessage({ok: true, result: openFont()});
} catch (err) {
  parentPort.postMessage({ok: false, error: err.message});
}
