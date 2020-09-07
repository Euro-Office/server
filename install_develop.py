import sys
sys.path.append('../build_tools/scripts')
import os
import base
import subprocess
import ctypes
import checks_develop

def is_admin():
  try:
    return ctypes.windll.shell32.IsUserAnAdmin()
  except:
    return False

def installingProgram(sProgram):
  if sProgram == 'Node.js':
    print("Installing Node.js...")
    base.download("https://nodejs.org/dist/latest-v10.x/node-v10.22.0-x64.msi", './nodejs.msi')
    code = subprocess.call('msiexec.exe /i nodejs.msi /qn',  stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
    if code == 0:
      print("Install success!")
      base.delete_file('./nodejs.msi')
      return True
    else:
      print("Error!")
      base.delete_file('./nodejs.msi')
      return False
  elif sProgram == 'Java':
    print("Installing Java...")
    base.download("https://javadl.oracle.com/webapps/download/AutoDL?BundleId=242990_a4634525489241b9a9e1aa73d9e118e6", './java.exe')
    code = subprocess.call('java.exe /s',  stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
    if code == 0:
      print("Install success!")
      base.delete_file('./java.exe')
      return True
    else:
      print("Error!")
      base.delete_file('./java.exe')
      return False
  elif sProgram == 'RabbitMQ':
    print("Installing RabbitMQ...")
    base.download("https://github.com/rabbitmq/rabbitmq-server/releases/download/v3.8.8/rabbitmq-server-3.8.8.exe", './rabbitmq.exe')
    code = subprocess.call('rabbitmq.exe /S',  stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
    if code == 0:
      print("Install success!")
      base.delete_file('./rabbitmq.exe')
      return True
    else:
      print("Error!")
      base.delete_file('./rabbitmq.exe')
      return False

def deleteProgram(sName):
  if is_admin():
    print("Deleting " + sName + "...")
    code = subprocess.call('wmic product where name="' + sName + '" call uninstall',  stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
    if code == 0:
      print("Delete success!")
    else:
      print("Error!")
  else:
    ctypes.windll.shell32.ShellExecuteW(None, u"runas", unicode(sys.executable), unicode(''.join(sys.argv)), None, 1)
    sys.exit() 

def installNodejs(installedVersion):
  if installedVersion == '':
    print('Node.js not found.')
  else:
    print('Installed Node.js version: ' + str(installedVersion))
    
  nodejs_min_version = 8
  nodejs_max_version = 10
  if (installedVersion == ''):
    return installingProgram('Node.js')
  elif (nodejs_min_version > installedVersion or installedVersion > nodejs_max_version):
    print('Node.js version must be 8.x to 10.x')
    deleteProgram('Node.js')
    return installingProgram('Node.js')
  else:
    print('Valid Node.js version')
    return True
 
def installJava(javaBitness):
  if javaBitness == '':
    print('Java not found.') 
    return installingProgram('Java')
  elif javaBitness == 'x32':
    print('Installed java: ' + javaBitness)
    print('Java bitness must be x64')
    return installingProgram('Java')
  elif javaBitness == 'x64':
    print('Valid java bitness.')
    return True
    
def installRabbitMQ(result):
  if result.find('The specified service does not exist as an installed service') != -1:
    return installingProgram('RabbitMQ')
  else:
    print('RabbitMQ is installed')
    return True
    
try:
  if is_admin():
    base.print_info('Check Node.js version')
    installNodejs(checks_develop.check_nodejs_version())
    base.print_info('Check Java bitness')
    installJava(checks_develop.check_java_bitness())
    base.print_info('Check RabbitMQ')
    installRabbitMQ(checks_develop.check_rabbitmq())
  else:
    ctypes.windll.shell32.ShellExecuteW(None, u"runas", unicode(sys.executable), unicode(''.join(sys.argv)), None, 1)
    sys.exit()
except SystemExit:
  input("Ignoring SystemExit. Press Enter to continue...")
  

