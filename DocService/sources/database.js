/*
 * Copyright (C) Ascensio System SIA, 2009-2026
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation, together with the
 * additional terms provided in the LICENSE file.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. For
 * details, see the GNU AGPL at: https://www.gnu.org/licenses/agpl-3.0.html
 *
 * You can contact Ascensio System SIA by email at info@onlyoffice.com
 * or by postal mail at 20A-6 Ernesta Birznieka-Upisha Street, Riga,
 * LV-1050, Latvia, European Union.
 *
 * The interactive user interfaces in modified versions of the Program
 * are required to display Appropriate Legal Notices in accordance with
 * Section 5 of the GNU AGPL version 3.
 *
 * No trademark rights are granted under this License.
 *
 * All non-code elements of the Product, including illustrations,
 * icon sets, and technical writing content, are licensed under the
 * Creative Commons Attribution-ShareAlike 4.0 International License:
 * https://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 * This license applies only to such non-code elements and does not
 * modify or replace the licensing terms applicable to the Program's
 * source code, which remains licensed under the GNU Affero General
 * Public License v3.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const mongoDB = require('mongodb');
const config = require('./config.json');
const _errorConnection = true;

const logger = require('./../../Common/sources/logger');

function CreateDbClient() {
  return new mongoDB.Db(
    config['mongodb']['database'],
    new mongoDB.Server(config['mongodb']['host'], config['mongodb']['port'], {auto_reconnect: true}),
    {safe: false}
  );
}
exports.insert = function (_collectionName, _newElement) {
  const _db = CreateDbClient();
  if (!_db) {
    logger.error('Error _db');
    return;
  }

  _db.open((err, db) => {
    if (!err) {
      // open collection. If it doesn't exist, it will be created
      db.collection(_collectionName, (err, collection) => {
        if (!err) {
          collection.insert(_newElement);
        } else {
          logger.error('Error collection');
          return;
        }

        db.close();
      });
    } else {
      logger.error('Error open database');
    }
  });
};
exports.remove = function (_collectionName, _removeElements) {
  const _db = CreateDbClient();
  if (!_db) {
    logger.error('Error _db');
    return;
  }

  // Opening the database
  _db.open((err, db) => {
    if (!err) {
      // open collection. If it doesn't exist, it will be created
      db.collection(_collectionName, (err, collection) => {
        if (!err) {
          collection.remove(_removeElements, (_err, _collection) => {
            logger.info('All elements remove');
          });
        } else {
          logger.error('Error collection');
          return;
        }

        db.close();
      });
    } else {
      logger.error('Error open database');
    }
  });
};
exports.load = function (_collectionName, callbackFunction) {
  const _db = CreateDbClient();
  if (!_db) {
    logger.error('Error _db');
    return callbackFunction(null);
  }

  const result = [];

  // opening database
  _db.open((err, db) => {
    // open collection. If it doesn't exist, it will be created
    db.collection(_collectionName, (err, collection) => {
      // Get all elements of a collection with find()
      collection.find((err, cursor) => {
        cursor.each((err, item) => {
          // Null denotes the last element
          if (item != null) {
            if (!Object.hasOwn(result, item.docid)) {
              result[item.docid] = [item];
            } else {
              result[item.docid].push(item);
            }
          } else {
            callbackFunction(result);
          }
        });

        db.close();
      });
    });
  });
};
