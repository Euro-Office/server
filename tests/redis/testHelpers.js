'use strict';

function context(tenant, overrides = {}) {
  return {
    tenant,
    getCfg(path, fallback) {
      return Object.hasOwn(overrides, path) ? overrides[path] : fallback;
    }
  };
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function publicMethods(instance) {
  const result = new Set();
  let prototype = Object.getPrototypeOf(instance);
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name !== 'constructor' && !name.startsWith('_') && typeof prototype[name] === 'function') {
        result.add(name);
      }
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return [...result].sort();
}

module.exports = {context, wait, publicMethods};
