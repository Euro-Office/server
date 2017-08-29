/*
 * (c) Copyright Ascensio System SIA 2010-2017
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
 * You can contact Ascensio System SIA at Lubanas st. 125a-25, Riga, Latvia,
 * EU, LV-1021.
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
var os = require('os');
var path = require('path');
var fs = require('fs');
var url = require('url');
var childProcess = require('child_process');
var co = require('co');
var config = require('config');
var spawnAsync = require('@expo/spawn-async');
var configConverter = config.get('FileConverter.converter');

var commonDefines = require('./../../Common/sources/commondefines');
var storage = require('./../../Common/sources/storage-base');
var utils = require('./../../Common/sources/utils');
var logger = require('./../../Common/sources/logger');
var constants = require('./../../Common/sources/constants');
var baseConnector = require('./../../DocService/sources/baseConnector');
var statsDClient = require('./../../Common/sources/statsdclient');
var queueService = require('./../../Common/sources/taskqueueRabbitMQ');

var cfgDownloadMaxBytes = configConverter.has('maxDownloadBytes') ? configConverter.get('maxDownloadBytes') : 100000000;
var cfgDownloadTimeout = configConverter.has('downloadTimeout') ? configConverter.get('downloadTimeout') : 60;
var cfgDownloadAttemptMaxCount = configConverter.has('downloadAttemptMaxCount') ? configConverter.get('downloadAttemptMaxCount') : 3;
var cfgDownloadAttemptDelay = configConverter.has('downloadAttemptDelay') ? configConverter.get('downloadAttemptDelay') : 1000;
var cfgFontDir = configConverter.get('fontDir');
var cfgPresentationThemesDir = configConverter.get('presentationThemesDir');
var cfgFilePath = configConverter.get('filePath');
var cfgArgs = configConverter.get('args');
var cfgErrorFiles = configConverter.get('errorfiles');
var cfgTokenEnableRequestOutbox = config.get('services.CoAuthoring.token.enable.request.outbox');

//windows limit 512(2048) https://msdn.microsoft.com/en-us/library/6e3b887c.aspx
//Ubuntu 14.04 limit 4096 http://underyx.me/2015/05/18/raising-the-maximum-number-of-file-descriptors.html
//MacOs limit 2048 http://apple.stackexchange.com/questions/33715/too-many-open-files
var MAX_OPEN_FILES = 200;
var TEMP_PREFIX = 'ASC_CONVERT';
var queue = null;
var clientStatsD = statsDClient.getClient();
var exitCodesReturn = [constants.CONVERT_NEED_PARAMS, constants.CONVERT_CORRUPTED, constants.CONVERT_DRM,
  constants.CONVERT_PASSWORD];
var exitCodesMinorError = [constants.CONVERT_NEED_PARAMS, constants.CONVERT_DRM, constants.CONVERT_PASSWORD];
var exitCodesUpload = [constants.NO_ERROR, constants.CONVERT_CORRUPTED, constants.CONVERT_NEED_PARAMS,
  constants.CONVERT_DRM];

function TaskQueueDataConvert(task) {
  var cmd = task.getCmd();
  this.key = cmd.savekey ? cmd.savekey : cmd.id;
  this.fileFrom = null;
  this.fileTo = null;
  this.formatTo = cmd.outputformat;
  this.csvTxtEncoding = cmd.getCodepage();
  this.csvDelimiter = cmd.getDelimiter();
  this.csvDelimiterChar = cmd.getDelimiterChar();
  this.paid = task.getPaid();
  this.embeddedFonts = cmd.embeddedfonts;
  this.fromChanges = task.getFromChanges();
  //todo
  if (cfgFontDir) {
    this.fontDir = path.resolve(cfgFontDir);
  } else {
    this.fontDir = cfgFontDir;
  }
  this.themeDir = path.resolve(cfgPresentationThemesDir);
  this.mailMergeSend = cmd.mailmergesend;
  this.thumbnail = cmd.thumbnail;
  this.doctParams = cmd.getDoctParams();
  this.password = cmd.getPassword();
  this.noBase64 = cmd.getNoBase64();
  this.timestamp = new Date();
}
TaskQueueDataConvert.prototype = {
  serialize: function(fsPath) {
    var xml = '\ufeff<?xml version="1.0" encoding="utf-8"?>';
    xml += '<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
    xml += ' xmlns:xsd="http://www.w3.org/2001/XMLSchema">';
    xml += this.serializeXmlProp('m_sKey', this.key);
    xml += this.serializeXmlProp('m_sFileFrom', this.fileFrom);
    xml += this.serializeXmlProp('m_sFileTo', this.fileTo);
    xml += this.serializeXmlProp('m_nFormatTo', this.formatTo);
    xml += this.serializeXmlProp('m_nCsvTxtEncoding', this.csvTxtEncoding);
    xml += this.serializeXmlProp('m_nCsvDelimiter', this.csvDelimiter);
    xml += this.serializeXmlProp('m_nCsvDelimiterChar', this.csvDelimiterChar);
    xml += this.serializeXmlProp('m_bPaid', this.paid);
    xml += this.serializeXmlProp('m_bEmbeddedFonts', this.embeddedFonts);
    xml += this.serializeXmlProp('m_bFromChanges', this.fromChanges);
    xml += this.serializeXmlProp('m_sFontDir', this.fontDir);
    xml += this.serializeXmlProp('m_sThemeDir', this.themeDir);
    if (this.mailMergeSend) {
      xml += this.serializeMailMerge(this.mailMergeSend);
    }
    if (this.thumbnail) {
      xml += this.serializeThumbnail(this.thumbnail);
    }
    xml += this.serializeXmlProp('m_nDoctParams', this.doctParams);
    xml += this.serializeXmlProp('m_sPassword', this.password);
    xml += this.serializeXmlProp('m_oTimestamp', this.timestamp.toISOString());
    xml += this.serializeXmlProp('m_bIsNoBase64', this.noBase64);
    xml += '</TaskQueueDataConvert>';
    fs.writeFileSync(fsPath, xml, {encoding: 'utf8'});
  },
  serializeMailMerge: function(data) {
    var xml = '<m_oMailMergeSend>';
    xml += this.serializeXmlProp('from', data.getFrom());
    xml += this.serializeXmlProp('to', data.getTo());
    xml += this.serializeXmlProp('subject', data.getSubject());
    xml += this.serializeXmlProp('mailFormat', data.getMailFormat());
    xml += this.serializeXmlProp('fileName', data.getFileName());
    xml += this.serializeXmlProp('message', data.getMessage());
    xml += this.serializeXmlProp('recordFrom', data.getRecordFrom());
    xml += this.serializeXmlProp('recordTo', data.getRecordTo());
    xml += this.serializeXmlProp('recordCount', data.getRecordCount());
    xml += this.serializeXmlProp('userid', data.getUserId());
    xml += this.serializeXmlProp('url', data.getUrl());
    xml += '</m_oMailMergeSend>';
    return xml;
  },
  serializeThumbnail: function(data) {
    var xml = '<m_oThumbnail>';
    xml += this.serializeXmlProp('format', data.getFormat());
    xml += this.serializeXmlProp('aspect', data.getAspect());
    xml += this.serializeXmlProp('first', data.getFirst());
    xml += this.serializeXmlProp('width', data.getWidth());
    xml += this.serializeXmlProp('height', data.getHeight());
    xml += '</m_oThumbnail>';
    return xml;
  },
  serializeXmlProp: function(name, value) {
    var xml = '';
    if (null != value) {
      xml += '<' + name + '>';
      xml += utils.encodeXml(value.toString());
      xml += '</' + name + '>';
    } else {
      xml += '<' + name + ' xsi:nil="true" />';
    }
    return xml;
  }
};

function getTempDir() {
  var tempDir = os.tmpdir();
  var now = new Date();
  var newTemp;
  while (!newTemp || fs.existsSync(newTemp)) {
    var newName = [TEMP_PREFIX, now.getYear(), now.getMonth(), now.getDate(),
      '-', (Math.random() * 0x100000000 + 1).toString(36)
    ].join('');
    newTemp = path.join(tempDir, newName);
  }
  fs.mkdirSync(newTemp);
  var sourceDir = path.join(newTemp, 'source');
  fs.mkdirSync(sourceDir);
  var resultDir = path.join(newTemp, 'result');
  fs.mkdirSync(resultDir);
  return {temp: newTemp, source: sourceDir, result: resultDir};
}
function* downloadFile(docId, uri, fileFrom) {
  var res = false;
  var data = null;
  var downloadAttemptCount = 0;
  var urlParsed = url.parse(uri);
  var filterStatus = yield* utils.checkHostFilter(urlParsed.hostname);
  if (0 == filterStatus) {
    while (!res && downloadAttemptCount++ < cfgDownloadAttemptMaxCount) {
      try {
        let authorization;
        if (cfgTokenEnableRequestOutbox) {
          authorization = utils.fillJwtForRequest();
        }
        data = yield utils.downloadUrlPromise(uri, cfgDownloadTimeout * 1000, cfgDownloadMaxBytes, authorization);
        res = true;
      } catch (err) {
        res = false;
        logger.error('error downloadFile:url=%s;attempt=%d;code:%s;connect:%s;(id=%s)\r\n%s', uri, downloadAttemptCount, err.code, err.connect, docId, err.stack);
        //not continue attempts if timeout
        if (err.code === 'ETIMEDOUT' || err.code === 'EMSGSIZE') {
          break;
        } else {
          yield utils.sleep(cfgDownloadAttemptDelay);
        }
      }
    }
    if (res) {
      logger.debug('downloadFile complete(id=%s)', docId);
      fs.writeFileSync(fileFrom, data);
    }
  } else {
    logger.error('checkIpFilter error:url=%s;code:%s;(id=%s)', uri, filterStatus, docId);
    res = false;
  }
  return res;
}
function promiseGetChanges(key, forceSave) {
  return new Promise(function(resolve, reject) {
    var time;
    var index;
    if (forceSave) {
      time = forceSave.getTime();
      index = forceSave.getIndex();
    }
    baseConnector.getChanges(key, time, index, function(err, result) {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}
function* downloadFileFromStorage(id, strPath, dir) {
  var list = yield storage.listObjects(strPath);
  logger.debug('downloadFileFromStorage list %s (id=%s)', list.toString(), id);
  //create dirs
  var dirsToCreate = [];
  var dirStruct = {};
  list.forEach(function(file) {
    var curDirPath = dir;
    var curDirStruct = dirStruct;
    var parts = storage.getRelativePath(strPath, file).split('/');
    for (var i = 0; i < parts.length - 1; ++i) {
      var part = parts[i];
      curDirPath = path.join(curDirPath, part);
      if (!curDirStruct[part]) {
        curDirStruct[part] = {};
        dirsToCreate.push(curDirPath);
      }
    }
  });
  //make dirs
  for (var i = 0; i < dirsToCreate.length; ++i) {
    fs.mkdirSync(dirsToCreate[i]);
  }
  //download
  //todo Promise.all
  for (var i = 0; i < list.length; ++i) {
    var file = list[i];
    var fileRel = storage.getRelativePath(strPath, file);
    var data = yield storage.getObject(file);
    fs.writeFileSync(path.join(dir, fileRel), data);
  }
}
function* processDownloadFromStorage(dataConvert, cmd, task, tempDirs) {
  if (task.getFromOrigin() || task.getFromSettings()) {
    dataConvert.fileFrom = path.join(tempDirs.source, 'origin.' + cmd.getFormat());
  } else {
    //перезаписываем некоторые файлы из m_sKey(например Editor.bin или changes)
    yield* downloadFileFromStorage(cmd.getSaveKey(), cmd.getSaveKey(), tempDirs.source);
    dataConvert.fileFrom = path.join(tempDirs.source, 'Editor.bin');
    //при необходимости собираем файл из частей, вида EditorN.bin
    var parsedFrom = path.parse(dataConvert.fileFrom);
    var list = yield utils.listObjects(parsedFrom.dir, true);
    list.sort(utils.compareStringByLength);
    var fsFullFile = null;
    for (var i = 0; i < list.length; ++i) {
      var file = list[i];
      var parsedFile = path.parse(file);
      if (parsedFile.name !== parsedFrom.name && parsedFile.name.startsWith(parsedFrom.name)) {
        if (!fsFullFile) {
          fsFullFile = yield utils.promiseCreateWriteStream(dataConvert.fileFrom);
        }
        var fsCurFile = yield utils.promiseCreateReadStream(file);
        yield utils.pipeStreams(fsCurFile, fsFullFile, false);
      }
    }
    if (fsFullFile) {
      fsFullFile.end();
    }
  }
  //mail merge
  var mailMergeSend = cmd.getMailMergeSend();
  if (mailMergeSend) {
    yield* downloadFileFromStorage(mailMergeSend.getJsonKey(), mailMergeSend.getJsonKey(), tempDirs.source);
    //разбиваем на 2 файла
    var data = fs.readFileSync(dataConvert.fileFrom);
    var head = data.slice(0, 11).toString('ascii');
    var index = head.indexOf(';');
    if (-1 != index) {
      var lengthBinary = parseInt(head.substring(0, index));
      var dataJson = data.slice(index + 1 + lengthBinary);
      fs.writeFileSync(path.join(tempDirs.source, 'Editor.json'), dataJson);
      var dataBinary = data.slice(index + 1, index + 1 + lengthBinary);
      fs.writeFileSync(dataConvert.fileFrom, dataBinary);
    } else {
      logger.error('mail merge format (id=%s)', cmd.getDocId());
    }
  }
  if (task.getFromChanges()) {
    var changesDir = path.join(tempDirs.source, 'changes');
    fs.mkdirSync(changesDir);
    var indexFile = 0;
    var changesAuthor = null;
    var changesHistory = {
      serverVersion: commonDefines.buildVersion,
      changes: []
    };
    //todo writeable stream
    let changesBuffers = null;
    let changes = yield promiseGetChanges(cmd.getDocId(), cmd.getForceSave());
    for (var i = 0; i < changes.length; ++i) {
      var change = changes[i];
      if (null === changesAuthor || changesAuthor !== change.user_id_original) {
        if (null !== changesAuthor) {
          changesBuffers.push(new Buffer(']', 'utf8'));
          let dataZipFile = Buffer.concat(changesBuffers);
          changesBuffers = null;
          var fileName = 'changes' + (indexFile++) + '.json';
          var filePath = path.join(changesDir, fileName);
          fs.writeFileSync(filePath, dataZipFile);
        }
        changesAuthor = change.user_id_original;
        var strDate = baseConnector.getDateTime(change.change_date);
        changesHistory.changes.push({
          'created': strDate, 'user': {
            'id': changesAuthor, 'name': change.user_name
          }
        });
        changesBuffers = [];
        changesBuffers.push(new Buffer('[', 'utf8'));
      } else {
        changesBuffers.push(new Buffer(',', 'utf8'));
      }
      changesBuffers.push(new Buffer(change.change_data, 'utf8'));
    }
    if (null !== changesBuffers) {
      changesBuffers.push(new Buffer(']', 'utf8'));
      let dataZipFile = Buffer.concat(changesBuffers);
      changesBuffers = null;
      var fileName = 'changes' + (indexFile++) + '.json';
      var filePath = path.join(changesDir, fileName);
      fs.writeFileSync(filePath, dataZipFile);
    }
    cmd.setUserId(changesAuthor);
    fs.writeFileSync(path.join(tempDirs.result, 'changesHistory.json'), JSON.stringify(changesHistory), 'utf8');
  }
}
function* processUploadToStorage(dir, storagePath) {
  var list = yield utils.listObjects(dir);
  if (list.length < MAX_OPEN_FILES) {
    yield* processUploadToStorageChunk(list, dir, storagePath);
  } else {
    for (var i = 0, j = list.length; i < j; i += MAX_OPEN_FILES) {
      yield* processUploadToStorageChunk(list.slice(i, i + MAX_OPEN_FILES), dir, storagePath);
    }
  }
}
function* processUploadToStorageChunk(list, dir, storagePath) {
  yield Promise.all(list.map(function (curValue) {
    var data = fs.readFileSync(curValue);
    var localValue = storagePath + '/' + curValue.substring(dir.length + 1);
    return storage.putObject(localValue, data, data.length);
  }));
}
function writeProcessOutputToLog(docId, childRes, isDebug) {
  if (childRes) {
    if (undefined !== childRes.stdout) {
      if (isDebug) {
        logger.debug('stdout (id=%s):%s', docId, childRes.stdout);
      } else {
        logger.error('stdout (id=%s):%s', docId, childRes.stdout);
      }
    }
    if (undefined !== childRes.stderr) {
      if (isDebug) {
        logger.debug('stderr (id=%s):%s', docId, childRes.stderr);
      } else {
        logger.error('stderr (id=%s):%s', docId, childRes.stderr);
      }
    }
  }
}
function* postProcess(cmd, dataConvert, tempDirs, childRes, error, isTimeout) {
  var exitCode = 0;
  var exitSignal = null;
  if(childRes) {
    exitCode = childRes.status;
    exitSignal = childRes.signal;
  }
  if (0 !== exitCode || null !== exitSignal) {
    if (-1 !== exitCodesReturn.indexOf(-exitCode)) {
      error = -exitCode;
    } else if(isTimeout) {
      error = constants.CONVERT_TIMEOUT;
    } else {
      error = constants.CONVERT;
    }
    if (-1 !== exitCodesMinorError.indexOf(error)) {
      writeProcessOutputToLog(dataConvert.key, childRes, true);
      logger.debug('ExitCode (code=%d;signal=%s;error:%d;id=%s)', exitCode, exitSignal, error, dataConvert.key);
    } else {
      writeProcessOutputToLog(dataConvert.key, childRes, false);
      logger.error('ExitCode (code=%d;signal=%s;error:%d;id=%s)', exitCode, exitSignal, error, dataConvert.key);
      if (cfgErrorFiles) {
        yield* processUploadToStorage(tempDirs.temp, cfgErrorFiles + '/' + dataConvert.key);
        logger.debug('processUploadToStorage error complete(id=%s)', dataConvert.key);
      }
    }
  } else {
    writeProcessOutputToLog(dataConvert.key, childRes, true);
    logger.debug('ExitCode (code=%d;signal=%s;error:%d;id=%s)', exitCode, exitSignal, error, dataConvert.key);
  }
  if (-1 !== exitCodesUpload.indexOf(error)) {
    yield* processUploadToStorage(tempDirs.result, dataConvert.key);
    logger.debug('processUploadToStorage complete(id=%s)', dataConvert.key);
  }
  cmd.setStatusInfo(error);
  var existFile = false;
  try {
    existFile = fs.lstatSync(dataConvert.fileTo).isFile();
  } catch (err) {
    existFile = false;
  }
  if (!existFile) {
    //todo пересмотреть. загрулка в случае AVS_OFFICESTUDIO_FILE_OTHER_TEAMLAB_INNER x2t меняет расширение у файла.
    var fileToBasename = path.basename(dataConvert.fileTo);
    var fileToDir = path.dirname(dataConvert.fileTo);
    var files = fs.readdirSync(fileToDir);
    for (var i = 0; i < files.length; ++i) {
      var fileCur = files[i];
      if (0 == fileCur.indexOf(fileToBasename)) {
        dataConvert.fileTo = path.join(fileToDir, fileCur);
        break;
      }
    }
  }
  cmd.setOutputPath(path.basename(dataConvert.fileTo));
  if(!cmd.getTitle()){
    cmd.setTitle(cmd.getOutputPath());
  }

  var res = new commonDefines.TaskQueueData();
  res.setCmd(cmd);
  logger.debug('output (data=%s;id=%s)', JSON.stringify(res), dataConvert.key);
  return res;
}
function deleteFolderRecursive(strPath) {
  if (fs.existsSync(strPath)) {
    var files = fs.readdirSync(strPath);
    files.forEach(function(file) {
      var curPath = path.join(strPath, file);
      if (fs.lstatSync(curPath).isDirectory()) { // recurse
        deleteFolderRecursive(curPath);
      } else { // delete file
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(strPath);
  }
}

function* ExecuteTask(task) {
  var startDate = null;
  var curDate = null;
  if(clientStatsD) {
    startDate = curDate = new Date();
  }
  var resData;
  var tempDirs;
  var getTaskTime = new Date();
  var cmd = task.getCmd();
  var dataConvert = new TaskQueueDataConvert(task);
  logger.debug('Start Task(id=%s)', dataConvert.key);
  var error = constants.NO_ERROR;
  tempDirs = getTempDir();
  dataConvert.fileTo = path.join(tempDirs.result, task.getToFile());
  if (cmd.getUrl()) {
    dataConvert.fileFrom = path.join(tempDirs.source, dataConvert.key + '.' + cmd.getFormat());
    var isDownload = yield* downloadFile(dataConvert.key, cmd.getUrl(), dataConvert.fileFrom);
    if (!isDownload) {
      error = constants.CONVERT_DOWNLOAD;
    }
    if(clientStatsD) {
      clientStatsD.timing('conv.downloadFile', new Date() - curDate);
      curDate = new Date();
    }
  } else if (cmd.getSaveKey()) {
    yield* downloadFileFromStorage(cmd.getDocId(), cmd.getDocId(), tempDirs.source);
    logger.debug('downloadFileFromStorage complete(id=%s)', dataConvert.key);
    if(clientStatsD) {
      clientStatsD.timing('conv.downloadFileFromStorage', new Date() - curDate);
      curDate = new Date();
    }
    yield* processDownloadFromStorage(dataConvert, cmd, task, tempDirs);
  } else {
    error = constants.UNKNOWN;
  }
  var childRes = null;
  let isTimeout = false;
  if (constants.NO_ERROR === error) {
    if(constants.AVS_OFFICESTUDIO_FILE_OTHER_HTMLZIP === dataConvert.formatTo && cmd.getSaveKey() && !dataConvert.mailMergeSend) {
      //todo заглушка.вся конвертация на клиенте, но нет простого механизма сохранения на клиенте
      yield utils.pipeFiles(dataConvert.fileFrom, dataConvert.fileTo);
    } else {
      var paramsFile = path.join(tempDirs.temp, 'params.xml');
      dataConvert.serialize(paramsFile);
      var childArgs;
      if (cfgArgs.length > 0) {
        childArgs = cfgArgs.trim().replace(/  +/g, ' ').split(' ');
      } else {
        childArgs = [];
      }
      childArgs.push(paramsFile);
      let timeoutId;
      try {
        let spawnAsyncPromise = spawnAsync(cfgFilePath, childArgs);
        childRes = spawnAsyncPromise.child;
        let waitMS = task.getVisibilityTimeout() * 1000 - (new Date().getTime() - getTaskTime.getTime());
        timeoutId = setTimeout(function() {
          isTimeout = true;
          timeoutId = undefined;
          childRes.kill();
        }, waitMS);
        childRes = yield spawnAsyncPromise;
      } catch (err) {
        logger.error('error spawnAsync(id=%s)\r\n%s', cmd.getDocId(), err.stack);
        childRes = err;
      }
      if (undefined !== timeoutId) {
        clearTimeout(timeoutId);
      }
    }
    if(clientStatsD) {
      clientStatsD.timing('conv.spawnSync', new Date() - curDate);
      curDate = new Date();
    }
  }
  resData = yield* postProcess(cmd, dataConvert, tempDirs, childRes, error, isTimeout);
  logger.debug('postProcess (id=%s)', dataConvert.key);
  if(clientStatsD) {
    clientStatsD.timing('conv.postProcess', new Date() - curDate);
    curDate = new Date();
  }
  if (tempDirs) {
    deleteFolderRecursive(tempDirs.temp);
    logger.debug('deleteFolderRecursive (id=%s)', dataConvert.key);
    if(clientStatsD) {
      clientStatsD.timing('conv.deleteFolderRecursive', new Date() - curDate);
      curDate = new Date();
    }
  }
  if(clientStatsD) {
    clientStatsD.timing('conv.allconvert', new Date() - startDate);
  }
  return resData;
}

function receiveTask(data, dataRaw) {
  return co(function* () {
    var res = null;
    var task = null;
    try {
      task = new commonDefines.TaskQueueData(JSON.parse(data));
      if (task) {
        res = yield* ExecuteTask(task);
      }
    } catch (err) {
      logger.error(err);
    } finally {
      try {
        if (!res && task) {
          //если все упало так что даже нет res, все равно пытаемся отдать ошибку.
          var cmd = task.getCmd();
          cmd.setStatusInfo(constants.CONVERT);
          res = new commonDefines.TaskQueueData();
          res.setCmd(cmd);
        }
        if(res) {
          yield queue.addResponse(res);
        }
        yield queue.removeTask(dataRaw);
      } catch (err) {
        logger.error(err);
      }
    }
  });
}
function run() {
  queue = new queueService();
  queue.on('task', receiveTask);
  queue.init(false, true, true, false, function(err) {
    if (null != err) {
      logger.error('createTaskQueue error :\r\n%s', err.stack);
    }
  });
}
exports.run = run;
