/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {afterAll, describe, expect, test} = require('@jest/globals');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wopi-tests-'));
const templatesDir = path.join(tmpDir, 'templates');
fs.mkdirSync(path.join(templatesDir, 'en-US'), {recursive: true});
['docx', 'xlsx'].forEach(ext => fs.writeFileSync(path.join(templatesDir, 'en-US', `new.${ext}`), ''));
const formatsFile = path.join(tmpDir, 'formats.json');
fs.writeFileSync(
  formatsFile,
  JSON.stringify(['docx', 'dotx', 'xlsx', 'xltx'].map(name => ({name, type: name.startsWith('x') ? 'cell' : 'word', actions: ['view', 'edit']})))
);
process.env.NODE_CONFIG = JSON.stringify({
  services: {CoAuthoring: {server: {newFileTemplate: templatesDir, documentFormatsFile: formatsFile}}}
});

const wopiClient = require('../../DocService/sources/wopiClient');

afterAll(() => fs.rmSync(tmpDir, {recursive: true, force: true}));
const newFileTemplateUtils = require('../../DocService/sources/newFileTemplateUtils');
const wopiUtils = require('../../DocService/sources/wopiUtils');

function createCtx(sendAuthorizationHeader) {
  return {
    userSessionId: 'session',
    getCfg(key, defaultValue) {
      return key === 'wopi.sendAuthorizationHeader' ? sendAuthorizationHeader : defaultValue;
    }
  };
}

describe('fillStandardHeaders', () => {
  test('omits Authorization header when sendAuthorizationHeader is false', async () => {
    const headers = {};
    await wopiUtils.fillStandardHeaders(createCtx(false), headers, 'https://host/wopi/files/1', 'token');
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers).toHaveProperty('X-WOPI-SessionId', 'session');
  });

  test('sends Bearer token when sendAuthorizationHeader is true', async () => {
    const headers = {};
    await wopiUtils.fillStandardHeaders(createCtx(true), headers, 'https://host/wopi/files/1', 'token');
    expect(headers).toHaveProperty('Authorization', 'Bearer token');
  });
});

describe('newFileTemplateUtils', () => {
  test('maps template extensions to the created document extension', () => {
    expect(newFileTemplateUtils.getNewFileCreatedExt('dotx')).toBe('docx');
    expect(newFileTemplateUtils.getNewFileCreatedExt('XLTX')).toBe('xlsx');
    expect(newFileTemplateUtils.getNewFileCreatedExt('potx')).toBe('pptx');
    expect(newFileTemplateUtils.getNewFileCreatedExt('docx')).toBeUndefined();
  });

  test('uses the created document template for template extensions', () => {
    expect(newFileTemplateUtils.getNewFileTemplateExt('dotx')).toBe('docx');
    expect(newFileTemplateUtils.getNewFileTemplateExt('pptx')).toBe('pptx');
  });
});

describe('discovery', () => {
  test('advertises editnew with newext for template formats', async () => {
    const xml = await new Promise((resolve, reject) => {
      const req = {headers: {host: 'ds.example'}, protocol: 'https', query: {}, get: name => req.headers[name.toLowerCase()]};
      const res = {setHeader() {}, send: resolve, sendStatus: status => reject(new Error(`status ${status}`))};
      wopiClient.discovery(req, res);
    });
    expect(xml).toMatch(/<action name="editnew" ext="dotx" requires="locks,update" newext="docx"/);
    expect(xml).toMatch(/<action name="editnew" ext="xltx" requires="locks,update" newext="xlsx"/);
    expect(xml).toMatch(/<action name="editnew" ext="docx" requires="locks,update" urlsrc=/);
    expect(xml).not.toMatch(/undefined/);
  });
});
