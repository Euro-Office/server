var packageFile = require('./package.json');

module.exports = function (grunt) {

  var checkDependencies = {};
   
  for(var i of packageFile.npm) {
    checkDependencies[i] = {
      options: {
        install: true,
        continueAfterInstall: true,
        packageDir: i
      }
    }
  }
  
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    
    clean: {
      options: {
        force: true        
      },
      build: packageFile.build.dest
    },
    mkdir: {
      build: {
        options: {
          create: [packageFile.build.dest]
        },
      },
    },
    copy: {
      main: {
          expand: true,
          src: packageFile.build.src,
          dest: packageFile.build.dest
      }
    },    
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
          banner: '/*\n' +
                    ' * (c) Copyright Ascensio System Limited 2010-<%= grunt.template.today("yyyy") %>. All rights reserved\n' +
                    ' *\n' +
                    ' * <%= pkg.homepage %> \n' +
                    ' *\n' +
                    ' * Version: ' + process.env['PRODUCT_VERSION'] + ' (build:' + process.env['BUILD_NUMBER'] + ')\n' +
                    ' */\n',
          linebreak: false
        },
        files: {
          src: packageFile.postprocess.src
        }
      }
    },
    checkDependencies: checkDependencies
  });

  grunt.loadNpmTasks('grunt-contrib-clean');
  grunt.loadNpmTasks('grunt-contrib-copy');
  grunt.loadNpmTasks('grunt-mkdir');
  grunt.loadNpmTasks('grunt-stripcomments');
  grunt.loadNpmTasks('grunt-banner');
  grunt.loadNpmTasks('grunt-check-dependencies');
  
  grunt.registerTask('default', ['clean', 'mkdir', 'copy', 'comments', 'usebanner', 'checkDependencies']);

};