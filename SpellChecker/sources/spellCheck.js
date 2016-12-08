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

var sockjs = require('sockjs'),
	nodehun = require('nodehun'),
    config = require('config').get('SpellChecker'),
	logger = require('./../../Common/sources/logger'),
	fs = require('fs'),
	cfgSockjsUrl = require('config').get('services.CoAuthoring.server.sockjsUrl');
var arrDictionaries = {};

(function() {
	// Read dictionaries
	var arrDictionariesConfig = config.get('dictionaries');
	var oDictTmp = null, pathTmp = '', oDictName = null;
	for (var indexDict = 0, lengthDict = arrDictionariesConfig.length; indexDict < lengthDict; ++indexDict) {
		oDictTmp = arrDictionariesConfig[indexDict];
		oDictName = oDictTmp.name;
		pathTmp = __dirname + '/../dictionaries/' + oDictName + '/' + oDictName + '.';
		arrDictionaries[oDictTmp.id] = new nodehun(pathTmp + 'aff', pathTmp + 'dic');
	}
})();

/*function CheckDictionary (dict, correct, unCorrect) {
	if (dict) {
		dict.isCorrect(correct, function (err, correct, origWord) {
			console.log(err, correct, origWord);
			if (err || !correct) logger.error('Error: spelling correct word %s failed!', correct);
		});

		dict.spellSuggestions(unCorrect, function (err, correct, suggestions, origWord) {
			console.log(err, correct, suggestions, origWord);
			if (err || correct) logger.error('Error: spelling unCorrect word %s failed!', unCorrect);
		});
	} else {
		logger.error('Error: no dictionary');
	}
}
CheckDictionary(arrDictionaries[0x0409], 'color', 'calor');*/
 
exports.install = function (server, callbackFunction) {
	'use strict';
	var sockjs_opts = {sockjs_url: cfgSockjsUrl},
		sockjs_echo = sockjs.createServer(sockjs_opts);

	sockjs_echo.on('connection', function (conn) {
		if (null == conn) {
			logger.error ("null == conn");
			return;
		}
		conn.on('data', function (message) {
			try {
				var data = JSON.parse(message);
				switch (data.type) {
					case 'spellCheck':	spellCheck(conn, data);break;
				}
			} catch (e) {
				logger.error("error receiving response: %s", e);
			}
		});
		conn.on('error', function () {
			logger.error("On error");
		});
		conn.on('close', function () {
			logger.info("Connection closed or timed out");
		});
	});

	function sendData(conn, data) {
		conn.write(JSON.stringify(data));
	}

	function spellCheck(conn, data) {
		var oSpellInfo;
		function checkEnd() {
			if (0 === oSpellInfo.usrWordsLength) {
				sendData(conn, { type:"spellCheck", spellCheckData:JSON.stringify(data) });
			}
		}
		function spellSuggest(index, word, lang) {
			oSpellInfo.arrTimes[index] = new Date();
			logger.info('start %s word = %s, lang = %s', data.type, word, lang);
			var oDictionary = arrDictionaries[lang];
			if (undefined === oDictionary) {
				data.usrCorrect[index] = false;
				--data.usrWordsLength;
				checkEnd();
			} else if ("spell" === data.type) {
				oDictionary.isCorrect(word, function (err, correct, origWord) {
					data.usrCorrect[index] = (!err && correct);
					logger.info('spell word = %s, lang = %s, time = %s', word, lang, new Date() - oSpellInfo.arrTimes[index]);
					--oSpellInfo.usrWordsLength;
					checkEnd();
				});
			} else if ("suggest" === data.type) {
				oDictionary.spellSuggestions(word, function (err, correct, suggestions, origWord) {
					data.usrSuggest[index] = suggestions;
					logger.info('suggest word = %s, lang = %s, time = %s', word, lang, new Date() - oSpellInfo.arrTimes[index]);
					--oSpellInfo.usrWordsLength;
					checkEnd();
				});
			}
		}

		data = JSON.parse(data.spellCheckData);
		// Ответ
		data.usrCorrect = [];
		data.usrSuggest = [];

		oSpellInfo = {usrWordsLength: data.usrWords.length, arrTimes: []};

		//data.start = new Date();
		for (var i = 0, length = data.usrWords.length; i < length; ++i) {
			spellSuggest(i, data.usrWords[i], data.usrLang[i]);
		}
	}

	sockjs_echo.installHandlers(server, {prefix:'/doc/[0-9-.a-zA-Z_=]*/c', log:function (severity, message) {
		//TODO: handle severity
		logger.info(message);
	}});

	callbackFunction();
};
exports.spellSuggest = function (type, word, lang, callbackFunction) {
	var oDictionary = arrDictionaries[lang];
	if (undefined === oDictionary) {
		callbackFunction(false);
	} else if ('spell' === type) {
		oDictionary.isCorrect(word, function (err, correct, origWord) {
			callbackFunction(!err && correct);
		});
	} else if ('suggest' === type) {
		oDictionary.spellSuggestions(word, function (err, correct, suggestions, origWord) {
			callbackFunction(suggestions);
		});
	}
};
