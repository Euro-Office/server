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

const buildVersion = '4.0.0';
const buildNumber = 19;
const buildDate = '6/29/2016';
const oBuildDate = new Date(buildDate);
const oPackageType = constants.PACKAGE_TYPE_OS;

const cfgRedisPrefix = config.get('services.CoAuthoring.redis.prefix');
const redisKeyLicense = cfgRedisPrefix + ((constants.PACKAGE_TYPE_OS === oPackageType) ? constants.REDIS_KEY_LICENSE :
	constants.REDIS_KEY_LICENSE_T);

exports.readLicense = function*() {
	const c_LR = constants.LICENSE_RESULT;
	const resMax = {count: 999999, type: c_LR.Success};
	var res = {count: 1, type: c_LR.Error, light: false, packageType: oPackageType, trial: false};
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
			const isTrial = res.trial = (true === oLicense['trial'] || 'true' === oLicense['trial']);
			const checkDate = (isTrial && constants.PACKAGE_TYPE_OS === oPackageType) ? new Date() : oBuildDate; // Someone who likes to put json string instead of bool
			if (endDate >= checkDate && 2 <= oLicense['version']) {
				res.count = Math.min(Math.max(res.count, oLicense['process'] >> 0), resMax.count);
				res.type = c_LR.Success;
			} else {
				res.type = isTrial ? c_LR.ExpiredTrial : c_LR.Expired;
			}

			res.light = (true === oLicense['light'] || 'true' === oLicense['light']); // Someone who likes to put json string instead of bool
		}
	} catch (e) {
		res.count = 1;
		res.type = c_LR.Error;

		if (checkFile) {
			res.type = c_LR.ExpiredTrial;
		} else {
			if (constants.PACKAGE_TYPE_OS === oPackageType) {
				if (yield* _getFileState()) {
					res.type = c_LR.ExpiredTrial;
				}
			} else {
				res.type = (yield* _getFileState()) ? c_LR.Success : c_LR.ExpiredTrial;
				if (res.type === c_LR.Success) {
					res.trial = true;
					res.count = 2;
					return res;
				}
			}
		}
	}
	if (res.type === c_LR.Expired || res.type === c_LR.ExpiredTrial) {
		res.count = 1;
		logger.error('License Expired!!!');
	}

	if (checkFile) {
		yield* _updateFileState(true);
	}

	return res;
};

function* _getFileState() {
	const val = yield utils.promiseRedis(redisClient, redisClient.hget, redisKeyLicense, redisKeyLicense);
	if (constants.PACKAGE_TYPE_OS === oPackageType) {
		return val;
	}

	if (null === val) {
		yield* _updateFileState(false);
		return true;
	}

	var now = new Date();
	now.setMonth(now.getMonth() - 1);
	return (0 >= (now - new Date(val)));
}
function* _updateFileState(state) {
	const val = constants.PACKAGE_TYPE_OS === oPackageType ? redisKeyLicense : (state ? new Date(1) : new Date());
	yield utils.promiseRedis(redisClient, redisClient.hset, redisKeyLicense, redisKeyLicense, val);
}
exports.buildVersion = buildVersion;
exports.buildNumber = buildNumber;
