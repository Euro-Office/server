import sys
sys.path.append('../build_tools/scripts')
import base
import dependence as _dependence
import os
import subprocess

mysqlParams = _dependence.install_params['MySQLServer']

def check_MySQLConfig(mysqlPath = ''):
  if (mysqlPath == ''):
    mysqlPath = _dependence.get_mysql_install_path()
        
  if (base.run_command('"' + mysqlPath + 'bin\\mysql" -u ' + mysqlParams['user'] + ' -p' + mysqlParams['pass'] + ' -e "SHOW DATABASES;"')['stdout'].find('onlyoffice') == -1):
    print('Database onlyoffice not found')
    execMySQLScript(mysqlPath, os.getcwd() + '\\schema\\mysql\\createdb.sql')
  if (base.run_command('"' + mysqlPath + 'bin\\mysql" -u ' + mysqlParams['user'] + ' -p' + mysqlParams['pass'] + ' -e "SELECT plugin from mysql.user where User=' + "'" + mysqlParams['user'] + "';")['stdout'].find('mysql_native_password') == -1):
    print('Password encryption is not valid')
    set_MySQLEncrypt(mysqlPath, 'mysql_native_password')

  return True

def execMySQLScript(mysqlPath, scriptPath):
   print('Execution ' + scriptPath)
   code = subprocess.call('"' + mysqlPath + 'bin\\mysql" -u ' + mysqlParams['user'] + ' -p' + mysqlParams['pass'] + ' -e "source ' + scriptPath + '"', stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
   if (code != 0):
    print('Execution was failed!')
    return False
   print('Completed!')

def set_MySQLEncrypt(mysqlPath, sEncrypt):
  print('Setting MySQL password encrypting...')
  code = subprocess.call('"' + mysqlPath + 'bin\\mysql" -u ' + mysqlParams['user'] + ' -p' + mysqlParams['pass'] + ' -e "' + "ALTER USER '" + mysqlParams['user'] + "'@'localhost' IDENTIFIED WITH " + sEncrypt + " BY '" + mysqlParams['pass'] + "';" + '"', stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
  if (code != 0):
    print('Setting password encryption was failed!')
    return False
  print('Completed!')

def check_dependencies():
  final_dependence = _dependence.CDependencies()
  
  final_dependence.append(_dependence.check_nodejs())
  final_dependence.append(_dependence.check_java())
  final_dependence.append(_dependence.check_erlang())
  final_dependence.append(_dependence.check_rabbitmq())
  final_dependence.append(_dependence.check_gruntcli())
  final_dependence.append(_dependence.check_buildTools())
  final_dependence.append(_dependence.check_mysqlInstaller())
  final_dependence.append(_dependence.check_mysqlServer())
  
  return final_dependence
  
