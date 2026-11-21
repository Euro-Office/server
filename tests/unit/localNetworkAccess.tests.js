/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {describe, expect, jest, test} = require('@jest/globals');
// The config instance DocsCoServer reads (it resolves 'config' from DocService).
const CONFIG = '../../DocService/node_modules/config';
const config = require(CONFIG);
const operationContext = require('../../Common/sources/operationContext');

const KEY = 'security.allowLocalNetworkAccessIframes';

// Loads DocsCoServer with a fresh module registry, so its module-level config
// read runs again. With `withoutKey`, DocsCoServer sees a config that lacks the
// key, like the config of an older install or of the nightly image.
function loadDocsCoServer({withoutKey = false} = {}) {
  let docsCoServer;
  jest.isolateModules(() => {
    if (withoutKey) {
      jest.doMock(CONFIG, () => {
        const actual = jest.requireActual(CONFIG);
        return new Proxy(actual, {
          get(target, prop) {
            if (prop === 'has') {
              return key => key !== KEY && target.has(key);
            }
            if (prop === 'get') {
              return key => {
                if (key === KEY) {
                  throw new Error(`Configuration property "${key}" is not defined`);
                }
                return target.get(key);
              };
            }
            return Reflect.get(target, prop);
          }
        });
      });
    }
    docsCoServer = require('../../DocService/sources/DocsCoServer');
  });
  return docsCoServer;
}

function tenantCtx(tenantConfig = null) {
  const ctx = new operationContext.Context();
  ctx.config = tenantConfig;
  return ctx;
}

describe('allowLocalNetworkAccess in the license message', () => {
  test('is false by default', () => {
    expect(config.get(KEY)).toBe(false);
    expect(loadDocsCoServer().getAllowLocalNetworkAccess(tenantCtx())).toBe(false);
  });

  test('is true when the tenant config enables it', () => {
    const ctx = tenantCtx({security: {allowLocalNetworkAccessIframes: true}});
    expect(loadDocsCoServer().getAllowLocalNetworkAccess(ctx)).toBe(true);
  });

  test('is false when the config has no security section', () => {
    expect(loadDocsCoServer({withoutKey: true}).getAllowLocalNetworkAccess(tenantCtx())).toBe(false);
  });
});
