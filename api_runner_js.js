#!/usr/bin/env node
/**
 * Le Mat — JavaScript API Runner
 * Receives a request context on stdin (JSON), loads a user API file,
 * matches the route, executes the handler, and prints the response as JSON to stdout.
 */

const fs = require('fs');
const path = require('path');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const reqData = JSON.parse(input);
    await handleRequest(reqData);
  } catch (e) {
    console.log(JSON.stringify({ status: 500, body: { error: 'Invalid request data: ' + e.message } }));
  }
});

async function handleRequest(reqData) {
  const { file: apiFile, method, path: routePath, body, query = {}, headers = {}, project } = reqData;
  // CWD is the project root (set by main.py), _lemat_init.js lives there
  const projectDir = process.cwd();

  // Load _lemat_api_init.js (direct DB access, no HTTP deadlock)
  const initPath = path.join(projectDir, '_lemat_api_init.js');
  if (fs.existsSync(initPath)) {
    try {
      require(initPath);
    } catch (e) {
      // Continue even if init fails
    }
  }

  // Set up the route registry
  const routes = [];

  const api = {
    _register(method, routePattern, handler) {
      routes.push({ method: method.toUpperCase(), path: routePattern, handler });
    },
    get(p, fn) { this._register('GET', p, fn); },
    post(p, fn) { this._register('POST', p, fn); },
    put(p, fn) { this._register('PUT', p, fn); },
    delete(p, fn) { this._register('DELETE', p, fn); },
    patch(p, fn) { this._register('PATCH', p, fn); },
  };

  // Make api available globally
  global.api = api;

  // Load and execute the user file
  try {
    // Clear require cache for this file
    delete require.cache[require.resolve(apiFile)];
  } catch (e) { /* file not cached yet */ }

  try {
    require(apiFile);
  } catch (e) {
    console.log(JSON.stringify({ status: 500, body: { error: 'Error loading API file: ' + e.message, stack: e.stack } }));
    return;
  }

  // Match route
  let matched = null;
  let params = {};

  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue;
    // Convert :param to named groups
    const pattern = route.path.replace(/:(\w+)/g, '(?<$1>[^/]+)');
    const regex = new RegExp('^' + pattern + '$');
    const m = routePath.match(regex);
    if (m) {
      matched = route;
      params = m.groups || {};
      break;
    }
  }

  if (!matched) {
    console.log(JSON.stringify({ status: 404, body: { error: `No route matches ${method} ${routePath}` } }));
    return;
  }

  // Build request object
  const req = { method, path: routePath, body, query, headers, params };

  try {
    let result = matched.handler(req);
    // Handle async handlers
    if (result && typeof result.then === 'function') {
      result = await result;
    }

    let status = 200;
    let bodyOut = result;

    if (Array.isArray(result) && result.length === 2 && typeof result[0] === 'number') {
      status = result[0];
      bodyOut = result[1];
    } else if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
      status = result.status || 200;
      bodyOut = result.body;
    } else if (result === null || result === undefined) {
      status = 204;
      bodyOut = null;
    }

    console.log(JSON.stringify({ status, body: bodyOut }));
  } catch (e) {
    console.log(JSON.stringify({ status: 500, body: { error: e.message, stack: e.stack } }));
  }
}
