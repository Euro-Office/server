import sys
import subprocess
import ctypes 

def is_admin():
  try:
    return ctypes.windll.shell32.IsUserAnAdmin()
  except:
    return False

def check_nodejs_version():
  nodejs_version = run_command('node -v')
  if nodejs_version == '':
    return nodejs_version
   
  nodejs_cur_version = int(nodejs_version.split('.')[0][1:])
  return nodejs_cur_version
  
def check_java_bitness():
  java_version = run_command('java -version')
  if java_version == '':
    return java_version
  elif java_version.find('64-Bit') == -1:
    return 'x32'
  elif java_version.find('32-Bit') == -1:
    return 'x64'
    
def check_rabbitmq():
  return run_command('sc query RabbitMQ')
  
def run_command(sCommand):
  popen = subprocess.Popen(sCommand, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True) 
  result = ''
  try:
    stdout, stderr = popen.communicate()
    popen.wait()
    if sCommand == 'node -v':
      result = stdout.strip().decode("utf-8") 
    else:
      result = stdout.strip().decode("utf-8") + stderr.strip().decode("utf-8")
  finally:
    popen.stdout.close()
    popen.stderr.close()
  
  return result
   
