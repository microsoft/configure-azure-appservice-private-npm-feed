//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

/*eslint no-console: ["error", { allow: ["error", "warn", "dir", "log"] }] */

'use strict';

const async = require('async');
const configuration = require('painless-config-resolver');
const fs = require('fs');
const os = require('os');
const path = require('path');
const spawn = require('child_process').spawn;

const isWindows = os.platform() === 'win32';
const lineEnding = isWindows ? '\r\n' : '\n';
const userProfile = process.env.USERPROFILE;

const stripAuthProtocolPrefixes = ['http:', 'https:'];

const options = {
  graph: {
    npm: {
      cmd: 'env://NPM_CMD',
      npmrc: 'env://NPMRC_FILE',
      privateFeed: {
        feed: 'env://NPM_PRIVATE_FEED',
        registry: 'env://NPM_PRIVATE_FEED_REGISTRY',
        scope: 'env://NPM_PRIVATE_FEED_SCOPE',
        token: 'env://NPM_PRIVATE_FEED_TOKEN',
      },
    },
    webServer: {
      websiteSku: 'env://WEBSITE_SKU',
    },
  },
};

function main() {
  const root = {
    applicationRoot: process.cwd(),
  };
  configuration(root).resolve(options, (resolutionError, config) => {
    if (resolutionError) {
      console.error(resolutionError);
      process.exit(1);
    }
    if (!config.webServer.websiteSku) {
      console.warn('The current environment does not appear to be Azure App Service. This script is only designed for Azure App Service at this time.');
    }
    configureNpm(config, (error) => {
      if (error) {
        console.error(error);
      }
      process.exit(error ? 1 : 0);
    });
  });
}

function configureNpm(config, callback) {
  let npmrc = config.npm.npmrc;
  if (!npmrc) {
    npmrc = isWindows ? path.resolve(userProfile, '.npmrc') : '~/.npmrc';
  }
  const npmCommand = config.npm.cmd || 'npm';

  const feed = config.npm.privateFeed.feed;
  if (!feed) {
    return callback();
  }

  const token = config.npm.privateFeed.token;
  if (!token) {
    return callback(new Error(`Although a feed "${feed}" was configured, no token has been found to use for this feed.`));
  }

  const work = [];

  // Store the feed authentication token
  const feedsAndKeys = {};
  feedsAndKeys[feed] = token;
  work.push(appendPrivateKeys.bind(null, npmrc, feedsAndKeys));

  // If there is a scope set, configure the scope with the registry
  const scopesAndRegistries = {};
  const scope = config.npm.privateFeed.scope;
  if (scope) {
    let registry = null;
    try {
      // If no registry is provided, it usually is the feed concat "registry"
      registry = config.npm.privateFeed.registry || buildRegistryValueFromFeed(feed);
    } catch (registryError) {
      return callback(registryError);
    }
    if (!registry) {
      return callback(new Error(`For the feed ${feed} and scope ${scope}, no registry value was configured.`));
    }
    scopesAndRegistries[scope] = registry;
    console.dir(scopesAndRegistries);
  }
  work.push(configureScopes.bind(null, npmCommand, scopesAndRegistries));

  async.series(work, callback);
}

function buildRegistryValueFromFeed(feed) {
  const originalFeed = feed;
  if (feed.startsWith('//')) {
    feed = 'https:' + feed;
  }
  let registry = null;
  stripAuthProtocolPrefixes.forEach(prefix => {
    if (feed.startsWith(prefix)) {
      if (feed.endsWith('registry')) {
        registry = feed;
        return;
      }
      if (!feed.endsWith('/')) {
        feed += '/';
      }
      registry = feed + 'registry';
      return;
    }
  });
  if (registry) {
    return registry;
  }
  throw new Error(`Could not automatically generate a registry URL for the feed "${originalFeed}".`);
}

function configureScopes(npmCommand, scopesAndRegistries, callback) {
  async.eachOfSeries(scopesAndRegistries, configureScope.bind(null, npmCommand), callback);
}

function configureScope(npmCommand, registry, scope, callback) {
  const scopeWithIndicator = `@${scope}`;
  callNpm(npmCommand, ['config', 'set', `${scopeWithIndicator}:always-auth`, 'true'], (err) => {
    if (err) {
      return callback(err);
    }
    callNpm(npmCommand, ['config', 'set', `${scopeWithIndicator}:registry`, registry], (error) => {
      const output = error ? console.error : console.log;
      output(error ? `Could not configure the scope ${scopeWithIndicator} for the registry ${registry}` : `Configured the scope ${scopeWithIndicator} for the registry ${registry}`);
      return callback(error);
    });
  });
}

function appendPrivateKeys(npmrcPath, feedsAndKeys, callback) {
  async.eachOfSeries(feedsAndKeys, appendPrivateKey.bind(null, npmrcPath), callback);
}

function appendPrivateKey(npmrcPath, key, feed, callback) {
  // The expected format these days (1/17) for .npmrc seems to be: //domain/feedPrefix:_authToken=TOKENVALUE
  stripAuthProtocolPrefixes.forEach(prefix => {
    if (feed.startsWith(prefix)) {
      feed = feed.substr(prefix.length);
    }
  });
  if (!feed.startsWith('//')) {
    return callback(new Error(`The feed "${feed}" does not match the expected prefix of //.`));
  }
  const configLine = `${feed}:_authToken=${key}`;
  fs.appendFile(npmrcPath, lineEnding + configLine + lineEnding, (error) => {
    const output = error ? console.error : console.log;
    output(error ? `Unable to store the token for the private feed ${feed}` : `Stored a token for the private feed ${feed}`);
    return callback(error);
  });
}

function callNpm(command, args, callback) {
  const exe = spawn(command, args, { shell: true });
  exe.stdout.on('data', data => {
    console.log(data);
  });
  exe.stderr.on('data', data => {
    console.error(data);
  });
  exe.on('exit', code => {
    return callback(code ? new Error(`The exit code of ${code} was non-zero from ${command}`) : null);
  });
}

exports.main = main;
