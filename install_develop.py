import sys
sys.path.append('../build_tools/scripts')
import os
import base
import dependence
import subprocess
import checks_develop as check
import shutil
import optparse
        
def installingProgram(sProgram, sParam = ''):
  if (sProgram == 'Node.js'):
    dependence.installProgram(sProgram)
    return True
  elif (sProgram == 'Java'):
    dependence.installProgram(sProgram)
    return True
  elif (sProgram == 'RabbitMQ'):
    dependence.installProgram(sProgram)
    return True
  elif (sProgram == 'Erlang'):
    dependence.installProgram(sProgram)
    return True
  elif (sProgram == 'GruntCli'):
    print('Installing Grunt-Cli...')
    code = subprocess.call('npm install -g grunt-cli',  stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
    if (code == 0):
      print("Install success!")
      return True
    else:
      print("Error!")
      return False
  elif (sProgram == 'MySQLInstaller'):
    dependence.installProgram(sProgram)
    return True
  elif (sProgram == 'MySQLServer'):
    print('Installing MySQL Server...')
    code = subprocess.call('"' + os.environ['ProgramFiles(x86)'] + '\\MySQL\\MySQL Installer for Windows\\MySQLInstallerConsole" community install server;8.0.21;x64:*:type=config;openfirewall=true;generallog=true;binlog=true;serverid=3306;enable_tcpip=true;port=3306;rootpasswd=onlyoffice -silent',  stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
    print(code)
    if (code == 0):
      print("Install success!")
      return True
    else:
      print("Error!")
      return False
  elif (sProgram == "BuildTools"):
    dependence.installProgram(sProgram)
    return True

arguments = sys.argv[1:]

parser = optparse.OptionParser()
parser.add_option("--install", action="append", type="string", dest="install", default=[], help="provides install dependencies")
parser.add_option("--uninstall", action="append", type="string", dest="uninstall", default=[], help="provides uninstall dependencies")
parser.add_option("--remove-path", action="append", type="string", dest="remove-path", default=[], help="provides path dependencies to remove")
parser.add_option("--mysql-path", action="store", type="string", dest="mysql-path", default="", help="provides path to mysql")

(options, args) = parser.parse_args(arguments)
configOptions = vars(options)
  
for item in configOptions["uninstall"]:
  dependence.uninstallProgram(item)
for item in configOptions["remove-path"]:
  if (base.is_dir(item) == True):
    shutil.rmtree(item)
for item in configOptions["install"]:
  installingProgram(item)
