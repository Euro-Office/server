/*
 * (c) Copyright Ascensio System SIA 2010-2016
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

const crypto = require('crypto');
const fs = require('fs');
const config = require('config');
const configL = config.get('license');
const constants = require('./constants');
const logger = require('./logger');
const utils = require('./utils');
const pubsubRedis = require('./../../DocService/sources/pubsubRedis');
const redisClient = pubsubRedis.getClientRedis();

const cfgRedisPrefix = config.get('services.CoAuthoring.redis.prefix');
const redisKeyLicense = cfgRedisPrefix + constants.REDIS_KEY_LICENSE;

const buildVersion = '4.0.0';
const buildNumber = 19;
const buildDate = '6/29/2016';
const oBuildDate = new Date(buildDate);

exports.readLicense = function*() {
	const resMax = {count: 999999, type: constants.LICENSE_RESULT.Success};
	var res = {count: 1, type: constants.LICENSE_RESULT.Error, light: false};
	var checkFile = false;
	try {
		var oFile = fs.readFileSync(configL.get('license_file')).toString();
		checkFile = true;
		var oLicense = JSON.parse(oFile);
		const sign = oLicense['signature'];
		delete oLicense['signature'];

		const verify = crypto.createVerify('RSA-SHA1');
		verify.update(JSON.stringify(oLicense));
		const publicKey = '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDRhGF7X4A0ZVlEg594WmODVVUI\niiPQs04aLmvfg8SborHss5gQXu0aIdUT6nb5rTh5hD2yfpF2WIW6M8z0WxRhwicg\nXwi80H1aLPf6lEPPLvN29EhQNjBpkFkAJUbS8uuhJEeKw0cE49g80eBBF4BCqSL6\nPFQbP9/rByxdxEoAIQIDAQAB\n-----END PUBLIC KEY-----\n';
		if (verify.verify(publicKey, sign, 'hex')) {
			const endDate = new Date(oLicense['end_date']);
			const checkDate = (false === oLicense['trial'] || 'false' === oLicense['trial']) ? oBuildDate : new Date(); // Someone who likes to put json string instead of bool
			if (endDate >= checkDate && 2 <= oLicense['version']) {
				res.count = Math.min(Math.max(res.count, oLicense['process'] >> 0), resMax.count);
				res.type = constants.LICENSE_RESULT.Success;
			} else {
				res.type = constants.LICENSE_RESULT.Expired;
			}

			res.light = !(false === oLicense['light'] || 'false' === oLicense['light']); // Someone who likes to put json string instead of bool
		}
	} catch (e) {
		res.count = 1;
		res.type = constants.LICENSE_RESULT.Error;

		if (checkFile || (yield* _getFileState())) {
			res.type = constants.LICENSE_RESULT.Expired;
		}
	}
	if (res.type === constants.LICENSE_RESULT.Expired) {
		res.count = 0;
		logger.error('License Expired!!!');
	}

	if (checkFile) {
		yield* _updateFileState();
	}

	return res;
};

function* _getFileState() {
	return yield utils.promiseRedis(redisClient, redisClient.hget, redisKeyLicense, redisKeyLicense);
}
function* _updateFileState() {
	yield utils.promiseRedis(redisClient, redisClient.hset, redisKeyLicense, redisKeyLicense, redisKeyLicense);
}
