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

const config = require('config');
const nodemailer = require('nodemailer');

const cfgConnection = config.util.cloneDeep(config.get('email.connectionConfiguration'));

const connectionDefaultSettings = {
  pool: true,
  socketTimeout: 1000 * 60 * 2,
  connectionTimeout: 1000 * 60 * 2,
  maxConnections: 10
};
// Connection settings could be overridden by config, so user can configure transporter anyhow.
const settings = Object.assign(connectionDefaultSettings, cfgConnection);
const smtpTransporters = new Map();

function createTransporter(ctx, host, port, auth, messageCommonParameters = {}) {
  const server = {
    host,
    port,
    auth,
    secure: port === 465
  };
  const transport = Object.assign({}, server, settings);

  try {
    if (smtpTransporters.has(`${host}:${auth.user}`)) {
      return;
    }

    const transporter = nodemailer.createTransport(transport, messageCommonParameters);
    smtpTransporters.set(`${host}:${auth.user}`, transporter);
  } catch (error) {
    ctx.logger.error(
      'Mail service smtp transporter creation error: %o\nWith parameters: \n\thost - %s, \n\tport - %d, \n\tauth = %o',
      error.stack,
      host,
      port,
      auth
    );
  }
}

async function send(host, userLogin, mailObject) {
  const transporter = smtpTransporters.get(`${host}:${userLogin}`);
  if (!transporter) {
    throw new Error(`MailService: no transporter exists for host "${host}" and user "${userLogin}"`);
  }

  return transporter.sendMail(mailObject);
}

function deleteTransporter(ctx, host, userLogin) {
  const transporter = smtpTransporters.get(`${host}:${userLogin}`);
  if (!transporter) {
    ctx.logger.error(`MailService: no transporter exists for host "${host}" and user "${userLogin}"`);
    return;
  }

  transporter.close();
  smtpTransporters.delete(`${host}:${userLogin}`);
}

function transportersRelease() {
  smtpTransporters.forEach(transporter => transporter.close());
  smtpTransporters.clear();
}

module.exports = {
  createTransporter,
  send,
  deleteTransporter,
  transportersRelease
};
