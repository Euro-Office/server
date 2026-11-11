// SPDX-FileCopyrightText: 2026 Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only

'use strict';

/**
 * Environment variables the converter child (x2t, docbuilder) inherits from the worker.
 * The x2t-specific names are the ones core reads through NSSystemUtils (DesktopEditor/common/SystemUtils.h);
 * the rest is what the dynamic linker, temp files, locale and outgoing requests of the child rely on.
 * Everything else in the worker's environment, e.g. database, broker, storage or token secrets, stays out.
 */
const INHERITED_ENV_NAMES = [
  // process basics
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
  'LANG',
  'LANGUAGE',
  // shared libraries next to the binaries
  'LD_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
  // Windows
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  // outgoing requests of the child
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  // read by x2t
  'APPLICATION_NAME',
  'COMPANY_NAME',
  'METHOD_CRYPT',
  'CREATOR',
  'CREATED',
  'X2T_MEMORY_LIMIT',
  'SIGNING_KEYSTORE_PASSPHRASE'
];
const INHERITED_ENV_PREFIXES = ['LC_'];

/**
 * Builds the environment for a converter child process from an allowlist instead of copying the worker's.
 * @param {Object<string, string>} parentEnv - the worker's environment (process.env)
 * @param {Object<string, string>} [configuredEnv] - FileConverter.converter.spawnOptions.env, passed on as configured
 * @returns {Object<string, string>}
 */
function getChildEnv(parentEnv, configuredEnv) {
  const env = {};
  for (const name of INHERITED_ENV_NAMES) {
    if (undefined !== parentEnv[name]) {
      env[name] = parentEnv[name];
    }
  }
  for (const name of Object.keys(parentEnv)) {
    if (INHERITED_ENV_PREFIXES.some(prefix => name.startsWith(prefix))) {
      env[name] = parentEnv[name];
    }
  }
  return Object.assign(env, configuredEnv);
}

module.exports = {getChildEnv, INHERITED_ENV_NAMES};