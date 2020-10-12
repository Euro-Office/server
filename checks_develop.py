import sys
sys.path.append('../build_tools/scripts')
import base
import dependence as _dependence
import subprocess

def check_MySQLConfig(mysqlPath = ''):
  dependence = _dependence.CDependencies()
  
  if (mysqlPath == ''):
    mysqlInfo = get_mysqlServersInfo()
    for info in mysqlInfo:
      if (info['Version'] == '8.0.21'):
        mysqlPath = info['Location']
        
  if (base.run_command('"' + mysqlPath + 'bin\\mysql" -u root -ponlyoffice -e "SHOW DATABASES;"')['stdout'].find('onlyoffice') == -1):
    print('Database onlyoffice not found')
    dependence.append_install('MySQLDatabase')
  if (base.run_command('"' + mysqlPath + 'bin\\mysql" -u root -ponlyoffice -e "SELECT plugin from mysql.user where User=' + "'root';")['stdout'].find('mysql_native_password') == -1):
    print('Password encryption is not valid')
    dependence.append_install('MySQLEncrypt') 
    
  dependence.mysqlPath = mysqlPath
  
  return dependence     

def execMySQLScript(mysqlPath, scriptPath):
   print('Execution ' + scriptPath)
   code = subprocess.call('"' + mysqlPath + 'bin\\mysql" -u root -ponlyoffice -e "source ' + scriptPath + '"', stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
   if (code != 0):
    print('Execution was failed!')
    return False
   print('Completed!')

def set_MySQLEncrypt(mysqlPath, sEncrypt):
  print('Setting MySQL password encrypting...')
  code = subprocess.call('"' + mysqlPath + 'bin\\mysql" -u root -ponlyoffice -e "' + "ALTER USER 'root'@'localhost' IDENTIFIED WITH " + sEncrypt + " BY 'onlyoffice';" + '"', stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
  if (code != 0):
    print('Setting password encryption was failed!')
    return False
  print('Completed!')

def check_npmPath():
  path = base.get_env('PATH')
  npmPath = os.environ['AppData'] + '\\npm'
  if (path.find(npmPath) == -1):
    base.set_env('PATH', npmPath + os.pathsep + path)

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
  
