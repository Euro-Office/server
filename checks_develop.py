import sys
sys.path.append('../build_tools/scripts')
import base
import subprocess
import os 

progsToInstall = []
progsToUninstall = []
pathsToRemove = []
pathToValidMySQLServer = ''

def check_nodejs():
  global progsToInstall, progsToUninstall
  base.print_info('Check installed Node.js version')
  nodejs_version = run_command('node -v')['stdout']
  if (nodejs_version == ''):
    print('Node.js not found')
    progsToInstall.append('Node.js')
    return False
  
  nodejs_cur_version = int(nodejs_version.split('.')[0][1:])
  print('Installed Node.js version: ' + str(nodejs_cur_version))
  nodejs_min_version = 8
  nodejs_max_version = 10
  if (nodejs_min_version > nodejs_cur_version or nodejs_cur_version > nodejs_max_version):
    print('Installed Node.js version must be 8.x to 10.x')
    progsToUninstall.append('Node.js')
    progsToInstall.append('Node.js')
    return False
  
  print('Installed Node.js version is valid')
  return True
  
def check_java():
  global progsToInstall
  base.print_info('Check installed Java')
  java_version = run_command('java -version')['stderr']
  
  if (java_version.find('64-Bit') != -1):
    print('Installed java is valid')
    return True
  
  if (java_version.find('32-Bit') != -1):
    print('Installed java must be x64')
  else:
    print('Java not found')
  
  progsToInstall.append('Java')
  return False
    
def check_rabbitmq():
  global progsToInstall
  base.print_info('Check installed RabbitMQ')
  result = run_command('sc query RabbitMQ')['stdout']
  if (result.find('RabbitMQ') == -1):
    progsToInstall.append('RabbitMQ')
    return False
  print('Installed RabbitMQ is valid')
  return True

def get_erlangPath():
  if (sys.version_info[0] >= 3):
    import winreg
  else:
    import _winreg as winreg
    
  Path = ""
  try:
    keyValue = r"SOFTWARE\WOW6432Node\Ericsson\Erlang"
    aKey = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, keyValue)
    count_subkey = winreg.QueryInfoKey(aKey)[0]
    
    for i in range(count_subkey):
      asubkey_name = winreg.EnumKey(aKey, i)
      if (asubkey_name.split(".")[0].isdigit()):
        asubkey = winreg.OpenKey(aKey, asubkey_name)
        Path = winreg.QueryValueEx(asubkey, None)[0]
      else:
        continue
    return Path
  except:
    return Path
    
def check_erlang():
  global progsToInstall, progsToUninstall
  base.print_info('Check installed Erlang')
  erlangPath = get_erlangPath()
  
  if (erlangPath != ""):
    erlangBitness = run_command('cd ' + erlangPath + '/bin && erl -eval "erlang:display(erlang:system_info(wordsize)), halt()." -noshell')['stdout']
    if (erlangBitness == '8'):
      if (os.getenv("ERLANG_HOME") != get_erlangPath()):
        progsToInstall.append('ERLANG_HOME')
      print("Installed Erlang bitness is valid")
      return True
    print('Installed Erlang must be x64') 
    progsToUninstall.append('Erlang')
  
  print('Erlang not found')
  progsToInstall.append('Erlang')
  progsToInstall.append('RabbitMQ')
  return False

def check_gruntcli():
  global progsToInstall
  base.print_info('Check Grunt-Cli')
  result = run_command('npm list -g --depth=0')['stdout']
  
  if (result.find('grunt-cli') == -1):
    print('Grunt-Cli not found')
    progsToInstall.append('GruntCli')
    return False
  else:
    print('Grunt-Cli is installed')
    return True
    
def get_mysqlServersPaths():
  if (sys.version_info[0] >= 3):
    import winreg
  else:
    import _winreg as winreg
    
  paths = []
  Path = ""
  
  try:
    keyValue = r"SOFTWARE\WOW6432Node\MySQL AB"
    
    try:
      aKey = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, keyValue)
    except:
      return Versions
      
    count_subkey = winreg.QueryInfoKey(aKey)[0]
    for i in range(count_subkey):
      asubkey_name = winreg.EnumKey(aKey, i)
      if (asubkey_name.find('MySQL Server') != - 1):
        asubkey = winreg.OpenKey(aKey, asubkey_name)
        Path = winreg.QueryValueEx(asubkey, 'Location')[0]
        paths.append(Path)
      else:
        continue
    return paths
  except:
    return paths
    
def get_mysqlServersDataPaths():
  if (sys.version_info[0] >= 3):
    import winreg
  else:
    import _winreg as winreg
  
  paths = []
  Path = ""
  
  try:
    keyValue = r"SOFTWARE\WOW6432Node\MySQL AB"
    
    try:
      aKey = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, keyValue)
    except:
      return Versions
      
    count_subkey = winreg.QueryInfoKey(aKey)[0]
    for i in range(count_subkey):
      asubkey_name = winreg.EnumKey(aKey, i)
      if (asubkey_name.find('MySQL Server') != - 1):
        asubkey = winreg.OpenKey(aKey, asubkey_name)
        Path = winreg.QueryValueEx(asubkey, 'DataLocation')[0]
        paths.append(Path)
      else:
        continue
    return paths
  except:
    return paths
    
def get_mysqlServersVersions():
  if (sys.version_info[0] >= 3):
    import winreg
  else:
    import _winreg as winreg
  
  Versions = []
  Version = ""
  
  try:
    keyValue = r"SOFTWARE\WOW6432Node\MySQL AB"
    
    try:
      aKey = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, keyValue)
    except:
      return Versions
      
    count_subkey = winreg.QueryInfoKey(aKey)[0]
    for i in range(count_subkey):
      asubkey_name = winreg.EnumKey(aKey, i)
      if (asubkey_name.find('MySQL Server') != - 1):
        asubkey = winreg.OpenKey(aKey, asubkey_name)
        Version = winreg.QueryValueEx(asubkey, 'Version')[0]
        Versions.append(Version)
      else:
        continue
    return Versions
  except:
    return Versions
    
def check_mysqlInstaller():
  global progsToInstall
  if (sys.version_info[0] >= 3):
    import winreg
  else:
    import _winreg as winreg
  
  try:
    keyValue = r"SOFTWARE\WOW6432Node\MySQL"
    
    try:
      aKey = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, keyValue)
    except:
      progsToInstall.append('MySQLInstaller')
      return False
      
    count_subkey = winreg.QueryInfoKey(aKey)[0]
    for i in range(count_subkey):
      asubkey_name = winreg.EnumKey(aKey, i)
      if (asubkey_name.find('MySQL Installer') != - 1):
        return True
    
    progsToInstall.append('MySQLInstaller')
    return False
  except:
    return False

def check_mysqlServersBitness(MySQLPaths):
  serversBitness = []
  
  for i in range(len(MySQLPaths)):
    mysqlServerPath = MySQLPaths[i]
    result = ""
    if (mysqlServerPath == ""):
      serversBitness.append("")
    else:
      result = run_command('cd ' + mysqlServerPath + 'bin && mysql --version')['stdout']
      if (result.find('for Win32') != -1):
        serversBitness.append('x32')
      elif (result.find('for Win64') != -1):
        serversBitness.append('x64')
      else:
        serversBitness.append('')
  return serversBitness
  
def check_mysqlServer(serversBitness, serversVersions, serversPaths, dataPaths, bAddToArrayToInstall):
  global progsToInstall, progsToUninstall, pathsToRemove, pathToValidMySQLServer
  base.print_info('Check MySQL Server')
  for i in range(len(serversBitness)):
    if serversBitness[i] != '':
      break
    if (i == len(serversBitness) - 1): 
      print('MySQL Server not found')
      progsToInstall.append('MySQLServer')
      return False
    
  for i in range(len(serversBitness)):
    result = serversBitness[i]
    if (result == ""):
      continue 
    elif (result == 'x32'):
      print('MySQL Server ' + serversVersions[i][0:3] + ' bitness is x32, is not valid')
      progsToUninstall.append('MySQL Server ' + serversVersions[i][0:3])
      continue
    elif (result == 'x64'):
      print('MySQL Server bitness is valid')
      connectionResult = run_command('cd ' + serversPaths[i] + 'bin && mysql -u root -ponlyoffice -e "SHOW GLOBAL VARIABLES LIKE ' + r"'PORT';" + '"')['stdout']
      if (connectionResult.find('port') != -1 and connectionResult.find('3306') != -1):
        if (run_command('cd ' + serversPaths[i] + 'bin && mysql -u root -ponlyoffice -e "SHOW DATABASES;"')['stdout'].find('onlyoffice') == -1):
          print('Database onlyoffice not found')
          progsToInstall.append('MySQLDatabase')
        if (run_command('cd ' + serversPaths[i] + 'bin && mysql -u root -ponlyoffice -e "SELECT plugin from mysql.user where User=' + "'root';")['stdout'].find('mysql_native_password') == -1):
          print('Password encryption is not valid')
          progsToInstall.append('MySQLEncrypt') 
        pathToValidMySQLServer = serversPaths[i]
        return True
      else:
        print('MySQL Server configuration is not valid')
        progsToUninstall.append('MySQL Server ' + serversVersions[i][0:3])
        pathsToRemove.append(serversPaths[i])
        progsToInstall.append('MySQLServer')
        continue
  
def check_buildTools():
  global progsToInstall
  base.print_info('Check Build Tools')
  result = run_command(os.path.split(os.getcwd())[0] + r'\build_tools\tools\win\vswhere\vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property DisplayName')['stdout']
  if (result == ''):
    progsToInstall.append('BuildTools')
    return False
  else:
    return True
  
def run_command(sCommand):
  popen = subprocess.Popen(sCommand, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True) 
  result = {'stdout' : '', 'stderr' : ''}
  try:
    stdout, stderr = popen.communicate()
    popen.wait()
    result['stdout'] = stdout.strip().decode("utf-8") 
    result['stderr'] = stderr.strip().decode("utf-8")
  finally:
    popen.stdout.close()
    popen.stderr.close()
  
  return result

def check_all():
  global progsToInstall, progsToUninstall, pathsToRemove, pathToValidMySQLServer
  check_nodejs()
  check_java()
  check_erlang()
  check_rabbitmq()
  check_gruntcli()
  check_buildTools()
  check_mysqlInstaller()
  
  mySQLServersPaths     = get_mysqlServersPaths()
  mySQLServersBitness   = check_mysqlServersBitness(mySQLServersPaths)
  mySQLServersVersions  = get_mysqlServersVersions()
  mySQLServersDataPaths = get_mysqlServersDataPaths()
  
  check_mysqlServer(mySQLServersBitness, mySQLServersVersions, mySQLServersPaths, mySQLServersDataPaths, True)
  return {'Uninstall': progsToUninstall, 'Install': progsToInstall, 'Paths': pathsToRemove, 'MySQLServer' : pathToValidMySQLServer}


