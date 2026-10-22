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
 * The  interactive user interfaces in modified source and object code versions
 * of the Program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU AGPL version 3.
 *
 * All the Product's GUI elements, including illustrations and icon sets, as
 * well as technical writing content are licensed under the terms of the
 * Creative Commons Attribution-ShareAlike 4.0 International. See the License
 * terms at http://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 */

'use strict';

const config = require('config');
const util = require('util');
const fs = require('fs');

const log4js = require('log4js');
const layouts = require('log4js/lib/layouts');
const reporters = require('./reporters');
const logConfigPath = config.get('log.filePath');
const logOptions = config.get('log.options');

// https://stackoverflow.com/a/36643588
const dateToJSONWithTZ = function (d) {
  const timezoneOffsetInHours = -(d.getTimezoneOffset() / 60); //UTC minus local time
  const sign = timezoneOffsetInHours >= 0 ? '+' : '-';
  const leadingZero = Math.abs(timezoneOffsetInHours) < 10 ? '0' : '';

  //It's a bit unfortunate that we need to construct a new Date instance
  //(we don't want _d_ Date instance to be modified)
  const correctedDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  correctedDate.setHours(d.getHours() + timezoneOffsetInHours);
  const iso = correctedDate.toISOString().replace('Z', '');
  return iso + sign + leadingZero + Math.abs(timezoneOffsetInHours).toString() + ':00';
};

log4js.addLayout('json', () => {
  // Copy instead of mutating: the event is shared with the appenders that run after this one
  return logEvent =>
    JSON.stringify({...logEvent, startTime: dateToJSONWithTZ(logEvent.startTime), message: util.format(...logEvent.data), data: undefined});
});

/**
 * Custom pattern layout that supports %x{usid} using USERSESSIONID from context.
 * @param {object} cfg
 * @returns {function}
 */
log4js.addLayout('patternWithTokens', cfg => {
  const pattern = cfg && cfg.pattern ? cfg.pattern : '%m';
  const baseTokens = cfg && cfg.tokens ? cfg.tokens : {};
  const tokens = Object.assign({}, baseTokens, {
    usid(ev) {
      const id = ev && ev.context && ev.context.USERSESSIONID;
      return id ? ` [${id}]` : '';
    }
  });
  return layouts.patternLayout(pattern, tokens);
});

const cachedLogConfig = JSON.parse(fs.readFileSync(logConfigPath, 'utf8'));
let curLogConfig = cachedLogConfig;

function withReporterAppenders(logConfig) {
  const reporterAppenders = reporters.appenders();
  const names = Object.keys(reporterAppenders);
  if (names.length === 0) {
    return logConfig;
  }
  const categories = {};
  for (const [name, category] of Object.entries(logConfig.categories)) {
    categories[name] = {...category, appenders: [...category.appenders, ...names]};
  }
  return {...logConfig, appenders: {...logConfig.appenders, ...reporterAppenders}, categories};
}

function configureLogger(options) {
  const mergedOptions = config.util.extendDeep({}, cachedLogConfig, options);
  log4js.configure(withReporterAppenders(mergedOptions));
  curLogConfig = mergedOptions;
}
configureLogger(logOptions);

/**
 * Copies an Error argument with only name, message, stack and code. Layouts, cluster IPC and reporters would otherwise
 * include every enumerable property, such as the request headers of axios errors.
 */
function leanError(arg) {
  if (!(arg instanceof Error)) {
    return arg;
  }
  const lean = new Error(arg.message);
  Object.defineProperty(lean, 'name', {value: arg.name});
  lean.stack = arg.stack ?? String(arg);
  if (arg.code !== undefined) {
    lean.code = arg.code;
  }
  return lean;
}

function withLeanErrors(instance) {
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    const log = instance[level].bind(instance);
    instance[level] = (...args) => log(...args.map(leanError));
  }
  return instance;
}

const logger = withLeanErrors(log4js.getLogger('nodeJS'));

if (config.get('log.options.replaceConsole')) {
  console.log = logger.info.bind(logger);
  console.info = logger.info.bind(logger);
  console.warn = logger.warn.bind(logger);
  console.error = logger.error.bind(logger);
  console.debug = logger.debug.bind(logger);
}
exports.getLogger = function () {
  return withLeanErrors(log4js.getLogger.apply(log4js, Array.prototype.slice.call(arguments)));
};
exports.trace = function () {
  return logger.trace.apply(logger, Array.prototype.slice.call(arguments));
};
exports.debug = function () {
  return logger.debug.apply(logger, Array.prototype.slice.call(arguments));
};
exports.info = function () {
  return logger.info.apply(logger, Array.prototype.slice.call(arguments));
};
exports.warn = function () {
  return logger.warn.apply(logger, Array.prototype.slice.call(arguments));
};
exports.error = function () {
  return logger.error.apply(logger, Array.prototype.slice.call(arguments));
};
exports.fatal = function () {
  return logger.fatal.apply(logger, Array.prototype.slice.call(arguments));
};
exports.shutdown = function (callback) {
  return log4js.shutdown(callback);
};
exports.configureLogger = configureLogger;
exports.getLoggerConfig = function () {
  return config.util.extendDeep({}, curLogConfig);
};
exports.getInitialLoggerConfig = function () {
  return config.util.extendDeep({}, cachedLogConfig);
};
