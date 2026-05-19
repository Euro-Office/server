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
const path = require('path');
const _ = require('lodash');
const packageFile = require('./package.json');

module.exports = function (grunt) {
  let addons = grunt.option('addon') || [];
  if (!Array.isArray(addons)) {
    addons = [addons];
  }

  addons.forEach((element, index, self) => (self[index] = path.join('..', element)));
  addons = addons.filter(element => grunt.file.isDir(element));

  function _merge(target, ...sources) {
    if (!sources.length) {
      return target;
    }
    const source = sources.shift();

    for (const key in source) {
      if (_.isObject(source[key])) {
        if (_.isArray(source[key])) {
          if (!_.isArray(target[key])) {
            target[key] = [];
          }
          target[key].push(...source[key]);
        } else {
          if (!target[key]) {
            Object.assign(target, {[key]: {}});
          }
          _merge(target[key], source[key]);
        }
      } else {
        Object.assign(target, {[key]: source[key]});
      }
    }
  }
  addons.forEach(element => {
    const _path = path.join(element, 'package.json');
    if (grunt.file.exists(_path)) {
      _merge(packageFile, require(_path));
      grunt.log.ok('addon '.green + element + ' is merged successfully'.green);
    }
  });

  //grunt.file.write("package-test.json", JSON.stringify(packageFile, null, 4));

  const checkDependencies = {};

  for (const i of packageFile.npm) {
    checkDependencies[i] = {
      options: {
        install: true,
        continueAfterInstall: true,
        packageDir: i
      }
    };
  }

  grunt.initConfig({
    clean: packageFile.grunt.clean,
    mkdir: packageFile.grunt.mkdir,
    copy: packageFile.grunt.copy,
    comments: {
      js: {
        options: {
          singleline: true,
          multiline: true
        },
        src: packageFile.postprocess.src
      }
    },
    usebanner: {
      copyright: {
        options: {
          position: 'top',
          banner:
            '/*\n' +
            ' * Copyright (C) ' +
            process.env['PUBLISHER_NAME'] +
            ' 2012-<%= grunt.template.today("yyyy") %>. All rights reserved\n' +
            ' *\n' +
            ' * ' +
            process.env['PUBLISHER_URL'] +
            ' \n' +
            ' *\n' +
            ' * Version: ' +
            process.env['PRODUCT_VERSION'] +
            ' (build:' +
            process.env['BUILD_NUMBER'] +
            ')\n' +
            ' */\n',
          linebreak: false
        },
        files: {
          src: packageFile.postprocess.src
        }
      }
    },
    checkDependencies
  });

  grunt.registerTask('build-develop', 'Build develop scripts', () => {
    grunt.initConfig({
      copy: packageFile.grunt['develop-copy']
    });
  });

  grunt.loadNpmTasks('grunt-contrib-clean');
  grunt.loadNpmTasks('grunt-contrib-copy');
  grunt.loadNpmTasks('grunt-mkdir');
  grunt.loadNpmTasks('grunt-stripcomments');
  grunt.loadNpmTasks('grunt-banner');
  grunt.loadNpmTasks('grunt-check-dependencies');

  grunt.registerTask('default', ['clean', 'mkdir', 'copy', 'comments', 'usebanner', 'checkDependencies']);
  grunt.registerTask('develop', ['build-develop', 'copy']);
};
