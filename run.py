#!/usr/bin/env python
import sys
sys.path.append('../build_tools/scripts')
import base
import subprocess

def check_nodejs_version():
  get_version_command = 'node -v'
  popen = subprocess.Popen(get_version_command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
  retvalue = ''
  try:
    stdout, stderr = popen.communicate()
    popen.wait()

    nodejs_version = stdout.strip()

  finally:
    popen.stdout.close()
    popen.stderr.close()

  print('Installed Node.js version: ' + nodejs_version)
  nodejs_min_version = 8
  nodejs_cur_version = int(nodejs_version.split('.')[0][1:])
  if (nodejs_min_version > nodejs_cur_version):
    print 'Node.js version!', nodejs_min_version, 'more than', nodejs_cur_version, '. Min version Node.js 8.x'
    return False

  return True

base.print_info('check Node.js version')
if (True != check_nodejs_version()):
  exit(0)

base.print_info('restart RabbitMQ node to prevent "Erl.exe high CPU usage every Monday morning on Windows" https://groups.google.com/forum/#!topic/rabbitmq-users/myl74gsYyYg')
print('ToDo: restart RabbitMQ')

base.print_info('Build modules')
print('ToDo: build_tools')

print('ToDo: create App_Data')

print('ToDo: copy spellcheck dictionaries')

base.print_info('Install node.js modules')
print('ToDo: Install node.js')

print('ToDo: set configs')
print('ToDo: start')
