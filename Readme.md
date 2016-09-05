
[![License](https://img.shields.io/badge/License-GNU%20AGPL%20V3-green.svg?style=flat)](http://www.gnu.org/licenses/agpl-3.0.ru.html) ![Release](https://img.shields.io/badge/Release-v4.1.0-blue.svg?style=flat)


## Server
The backend server software layer which is the part of [ONLYOFFICE Document Server][2] and is the base for all other components.

## Document service set up

This instruction describes document service deployment for Windows based platform.

### Installing necessary components

For the document service to work correctly it is necessary to install the following components for your Windows system (if not specified additionally, the latest version for 32 or 64 bit Windows can be installed with default settings):

a) Node.js 4.0.x 32 bit version (https://nodejs.org/dist/v4.0.0/node-v4.0.0-x86.msi) 

To find out which Node.js version is used on your system currently run the `node -v` command

The 32 bit version is necessary for the spellchecking module only. In case you do not plan to use this module, you can install 64 bit Node.js version.

b) MySql Server version 5.5 or later (http://dev.mysql.com/downloads/windows/installer/). When installing use the `onlyoffice` password for the `root` user

c) Erlang (http://www.erlang.org/download.html)

d) RabbitMQ (https://www.rabbitmq.com/releases/rabbitmq-server/v3.5.4/rabbitmq-server-3.5.4.exe)

e) Redis (https://github.com/MSOpenTech/redis/releases/download/win-2.8.2102/Redis-x64-2.8.2102.msi)

f) Python 2.7.x (http://www.python.org/download/releases/2.7.3/#download)

g) Microsoft Visual C++ Express 2010 (necessary for the spellchecker modules build)

### Setting up the system

a) Database setup

Run the schema/createdb.sql script for MySQL

b) Install the Web Monitor for RabbitMQ (see the details for the installation here - https://www.rabbitmq.com/management.html)

Open the command line `cmd` executable. Switch to the installation directory using the `cd /d Installation-directory/sbin` command.

Run the following command: 

```
rabbitmq-plugins.bat enable rabbitmq_management
```

The Web Monitor is located at the http://localhost:15672/ address. Use the `guest/guest` for the login/password combination.

c) If Redis does not start or crashes after the start for some reason, try to change the `maxheap` parameter in the config settings. For 64 bit version of Windows 7 the config file can be found here: C:\Program Files\Redis\redis.windows-service.conf. 

Find the `# maxheap <bytes>` line and change it to, e.g. 

```
maxheap 128MB
```

Restart the service.

### Running the service

Run the `run.bat` script to start the service.

Notes

All config files for the server part can be foun in the `Common\config` folder
* `default.json` - common config files similar for all production versions.
* `production-windows.json` - config files for the production version running on a Windows based platform.
* `production-linux.json` - config files for the production version running on a Linux based platform.
* `development-windows.json` - config files for the development version running on a Windows based platform (this configuration is used when running the 'run.bat' script).

In case it is necessary to temporarily edit the config files, create the local.json file and reassign the values there. It will allow to prevent from uploading local changes and losing config files when updating the repository. See https://github.com/lorenwest/node-config/wiki/Configuration-Files for more information about the configuration files.

## User Feedback and Support

If you have any problems with or questions about [ONLYOFFICE Document Server][2], please visit our official forum to find answers to your questions: [dev.onlyoffice.org][1] or you can ask and answer ONLYOFFICE development questions on [Stack Overflow][3].

  [1]: http://dev.onlyoffice.org
  [2]: https://github.com/ONLYOFFICE/DocumentServer
  [3]: http://stackoverflow.com/questions/tagged/onlyoffice

## License

Server is released under an GNU AGPL v3.0 license. See the LICENSE file for more information.
