import sys
sys.path.append('../build_tools/scripts')
import os
import base
import subprocess
import ctypes

def is_admin():
  try:
    return ctypes.windll.shell32.IsUserAnAdmin()
  except:
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

def installNodejs():
  if is_admin():
    base.download("https://nodejs.org/dist/latest-v10.x/node-v10.22.0-x64.msi", './nodejs.msi')
    print("Unstalling Node.js...")
    code = subprocess.call('cd ' + os.getcwd() + ' && msiexec.exe /i nodejs.msi /qn',  stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
    if code == 0:
      print("Install success!")
    else:
      print("Error!")
    base.delete_file('./nodejs.msi')
  else:
    ctypes.windll.shell32.ShellExecuteW(None, u"runas", unicode(sys.executable), unicode(''.join(sys.argv)), None, 1)
    sys.exit()
    
def installJava():
  if is_admin():
    base.download("https://javadl.oracle.com/webapps/download/AutoDL?BundleId=242990_a4634525489241b9a9e1aa73d9e118e6", './java.exe')
    print("Installing Java...")
    code = subprocess.call('cd ' + os.getcwd() + ' && java.exe /s',  stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
    if code == 0:
      print("Install success!")
    else:
      print("Error!")
      input()
    base.delete_file('./java.exe')
  else:
    ctypes.windll.shell32.ShellExecuteW(None, u"runas", unicode(sys.executable), unicode(''.join(sys.argv)), None, 1)
    sys.exit()
        
def check_nodejs_version():
  nodejs_version = chek_version('node -v')
    
  if nodejs_version == '':
    installNodejs()
    return True
 
  print('Installed Node.js version: ' + nodejs_version)
  nodejs_min_version = 8
  nodejs_max_version = 10
  nodejs_cur_version = int(nodejs_version.split('.')[0][1:])
  if (nodejs_min_version > nodejs_cur_version or nodejs_cur_version > nodejs_max_version):
    print('Node.js version must be 8.x to 10.x')
    deleteProgram('Node.js')
    installNodejs()
    return True

  return True
  
def check_java_bitness():
  java_bitness = chek_version('Java -version')
    
  if java_bitness == '':
    installJava()
    return True
 
  print('Installed Java bitness: x' + str(java_bitness))
  java_required_bitness = 64
  if java_bitness != java_required_bitness:
    print('Java bitness must be x64')
    #deleteProgram('Java')
    installJava()
    return True

  return True
  
def chek_version(sCommand):
  get_version_command = sCommand
  popen = subprocess.Popen(get_version_command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
   
  try:
    stdout, stderr = popen.communicate()
    popen.wait()
    progVersion = ''
    if sCommand == 'node -v':
      progVersion = stdout.strip().decode("utf-8")
    elif sCommand == 'Java -version':
      if stderr.find('32-Bit') != -1:
        progVersion = 32
      elif stderr.find('64-Bit') != -1:
        progVersion = 64
      else: 
        progVersion = ''
         
  finally:
    popen.stdout.close()
    popen.stderr.close()
    
  return progVersion