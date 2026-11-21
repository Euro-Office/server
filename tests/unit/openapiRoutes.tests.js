// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only

const fs = require('fs');
const path = require('path');
const {describe, test, expect} = require('@jest/globals');

const root = path.resolve(__dirname, '../..');
const sourceDirs = ['DocService/sources', 'Common/sources'].map(dir => path.join(root, dir));
const METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);

function listJsFiles(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listJsFiles(full);
    }
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function openapiBlocks(source) {
  return [...source.matchAll(/\/\*\*([\s\S]*?)\*\//g)]
    .map(match => match[1].split('\n').map(line => line.replace(/^\s*\* ?/, '')))
    .filter(lines => lines.some(line => line.trim() === '@openapi'))
    .map(lines => lines.slice(lines.findIndex(line => line.trim() === '@openapi') + 1));
}

// Reads `paths:` > `  /path:` > `    method:` from the YAML by indentation.
function documentedOperations(lines) {
  const operations = [];
  let inPaths = false;
  let currentPath;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inPaths = line.startsWith('paths:');
      continue;
    }
    if (!inPaths) {
      continue;
    }
    const pathMatch = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    const methodMatch = /^ {4}(\w+):\s*$/.exec(line);
    if (methodMatch && METHODS.has(methodMatch[1])) {
      operations.push(`${methodMatch[1]} ${currentPath}`);
    }
  }
  return operations;
}

function registeredRoutes() {
  const server = fs.readFileSync(path.join(root, 'DocService/sources/server.js'), 'utf8');
  return new Set([...server.matchAll(/app\.(get|post|put|delete|patch)\(\s*'([^']+)'/g)].map(match => `${match[1]} ${match[2]}`));
}

const documented = sourceDirs
  .flatMap(listJsFiles)
  .flatMap(file => openapiBlocks(fs.readFileSync(file, 'utf8')))
  .flatMap(documentedOperations);

describe('OpenAPI annotations', () => {
  test('document each operation once', () => {
    expect(documented.length).toBeGreaterThan(0);
    expect(new Set(documented).size).toBe(documented.length);
  });

  test('only document routes registered in server.js', () => {
    const routes = registeredRoutes();
    expect(documented.filter(operation => !routes.has(operation))).toEqual([]);
  });

  test('document the core public routes', () => {
    const core = ['post /converter', 'post /command', 'post /docbuilder', 'get /healthcheck'];
    expect(core.filter(operation => !documented.includes(operation))).toEqual([]);
  });
});
