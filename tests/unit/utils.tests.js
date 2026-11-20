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

const {describe, test, expect} = require('@jest/globals');
const config = require('../../Common/node_modules/config');

const operationContext = require('../../Common/sources/operationContext');
const utils = require('../../Common/sources/utils');

const ctx = new operationContext.Context();
const minimumIterationsByteLength = 4;

describe('AES encryption & decryption', () => {
  test('Iterations range', async () => {
    const configuration = config.util.cloneDeep(config.get('aesEncrypt.config'));
    const encrypted = await utils.encryptPassword(ctx, 'secretstring');
    const {iterationsByteLength = 5} = configuration;

    const [iterationsHex] = encrypted.split(':');
    const iterations = parseInt(iterationsHex, 16);

    const iterationsLength = iterationsByteLength < minimumIterationsByteLength ? minimumIterationsByteLength : iterationsByteLength;
    expect(iterations).toBeGreaterThanOrEqual(Math.pow(10, iterationsLength - 1));
    expect(iterations).toBeLessThanOrEqual(Math.pow(10, iterationsLength) - 1);
  });

  test('Correct workflow', async () => {
    const encrypted = await utils.encryptPassword(ctx, 'secretstring');
    const decrypted = await utils.decryptPassword(ctx, encrypted);
    expect(decrypted).toEqual('secretstring');
  });
});

describe('forgotten partial output', () => {
  const name = 'output';

  test('has its own name next to the regular forgotten file', () => {
    expect(utils.getForgottenPartialName(name)).toEqual('output-partial');
  });

  test.each([
    ['docId/output-partial.docx', true],
    ['docId/output-partial', true],
    ['/tmp/source/output-partial.xlsx', true],
    ['docId/output.docx', false],
    ['docId/output', false],
    ['docId/output-partial.docx/other.docx', false],
    ['docId/custom.docx', false]
  ])('isForgottenPartial(%s) is %s', (file, expected) => {
    expect(utils.isForgottenPartial(file, name)).toEqual(expected);
  });

  test('follows the configured forgotten file name', () => {
    expect(utils.isForgottenPartial('docId/saved-partial.docx', 'saved')).toEqual(true);
    expect(utils.isForgottenPartial('docId/output-partial.docx', 'saved')).toEqual(false);
  });

  test('getForgottenRegular keeps every file except the partial output', () => {
    const list = ['docId/output-partial.docx', 'docId/output.docx', 'docId/custom.docx'];
    expect(utils.getForgottenRegular(list, name)).toEqual(['docId/output.docx', 'docId/custom.docx']);
    expect(utils.getForgottenRegular(['docId/output-partial.docx'], name)).toEqual([]);
    expect(utils.getForgottenRegular([], name)).toEqual([]);
  });
});
