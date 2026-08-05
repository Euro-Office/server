'use strict';
const config = require('config');
const cookieParser = require('cookie-parser');
const express = require('express');
const multer = require('multer');
const operationContext = require('../../../../../Common/sources/operationContext');
const {validateJWT} = require('../../middleware/auth');
const fontsService = require('./fonts.service');

const cfgMaxFontFileSizeBytes = config.get('adminPanel.fonts.maxFontFileSizeBytes');

const maxUploadFiles = 9;

const router = express.Router();
router.use(express.json());
router.use(cookieParser());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {fileSize: cfgMaxFontFileSizeBytes, files: maxUploadFiles}
});

router.get('/', validateJWT, async (req, res) => {
  let fonts = [];
  try {
    fonts = await fontsService.listFonts();
  } catch (err) {
    if (err.code !== 'ENOENT') {
      (req.ctx || operationContext.global).logger.error('font list failed: %s', err.stack);
      return res.status(500).json({error: 'failed to read custom fonts directory'});
    }
  }
  res.status(200).json({fonts, regeneration: fontsService.getRegenerationStatus()});
});

router.post('/', validateJWT, upload.array('fonts', maxUploadFiles), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({error: 'no font files uploaded (expected multipart field "fonts")'});
  }
  try {
    const fonts = await fontsService.saveFonts(req.files);
    res.status(200).json({fonts});
  } catch (err) {
    if (err instanceof fontsService.FontValidationError) {
      return res.status(400).json({error: err.message, files: err.details});
    }
    (req.ctx || operationContext.global).logger.error('font upload failed: %s', err.stack);
    res.status(500).json({error: 'failed to store font files'});
  }
});

router.delete('/:filename', validateJWT, async (req, res) => {
  try {
    const file = await fontsService.deleteFont(req.params.filename);
    res.status(200).json({deleted: file});
  } catch (err) {
    if (err instanceof fontsService.FontValidationError) {
      return res.status(400).json({error: err.message});
    }
    if (err.code === 'ENOENT') {
      return res.status(404).json({error: 'font file not found'});
    }
    (req.ctx || operationContext.global).logger.error('font delete failed: %s', err.stack);
    res.status(500).json({error: 'failed to delete font file'});
  }
});

router.post('/regenerate', validateJWT, async (req, res) => {
  try {
    const status = await fontsService.startRegeneration();
    res.status(202).json(status);
  } catch (err) {
    if (err instanceof fontsService.RegenerationRunningError) {
      return res.status(409).json(fontsService.getRegenerationStatus());
    }
    if (err instanceof fontsService.RegenerationUnavailableError) {
      return res.status(501).json({error: err.message});
    }
    (req.ctx || operationContext.global).logger.error('font regeneration trigger failed: %s', err.stack);
    res.status(500).json({error: 'failed to start font regeneration'});
  }
});

router.get('/regenerate/status', validateJWT, (req, res) => {
  res.status(200).json(fontsService.getRegenerationStatus());
});

// Multer errors (size/count limits, unexpected field) surface here
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({error: `font file exceeds the ${cfgMaxFontFileSizeBytes} byte limit`});
    }
    return res.status(400).json({error: err.message});
  }
  next(err);
});

module.exports = router;
