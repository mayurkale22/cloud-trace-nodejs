/**
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const filesLoadedBeforeTrace = Object.keys(require.cache);

// semver does not require any core modules.
import * as semver from 'semver';

const useAH = !!process.env.GCLOUD_TRACE_NEW_CONTEXT &&
    semver.satisfies(process.version, '>=8');
if (!useAH) {
  // This should be loaded before any core modules.
  require('continuation-local-storage');
}

import * as common from '@google-cloud/common';
import {cls, TraceCLSConfig, TraceCLSMechanism} from './cls';
import {Constants} from './constants';
import {Config, defaultConfig, CLSMechanism} from './config';
import * as extend from 'extend';
import * as path from 'path';
import * as PluginTypes from './plugin-types';
import {PluginLoaderConfig} from './trace-plugin-loader';
import {pluginLoader} from './trace-plugin-loader';
import {TraceAgent} from './trace-api';
import {traceWriter, TraceWriterConfig} from './trace-writer';
import {Forceable, FORCE_NEW, packageNameFromPath} from './util';

export {Config, PluginTypes};

const traceAgent: TraceAgent = new TraceAgent('Custom Trace API');

const modulesLoadedBeforeTrace: string[] = [];
const traceModuleName = path.join('@google-cloud', 'trace-agent');
for (let i = 0; i < filesLoadedBeforeTrace.length; i++) {
  const moduleName = packageNameFromPath(filesLoadedBeforeTrace[i]);
  if (moduleName && moduleName !== traceModuleName &&
      modulesLoadedBeforeTrace.indexOf(moduleName) === -1) {
    modulesLoadedBeforeTrace.push(moduleName);
  }
}

interface TopLevelConfig {
  enabled: boolean;
  logLevel: number;
  clsMechanism: CLSMechanism;
}

// PluginLoaderConfig extends TraceAgentConfig
type NormalizedConfig = TraceWriterConfig&PluginLoaderConfig&TopLevelConfig;

/**
 * Normalizes the user-provided configuration object by adding default values
 * and overriding with env variables when they are provided.
 * @param projectConfig The user-provided configuration object. It will not
 * be modified.
 * @return A normalized configuration object.
 */
function initConfig(projectConfig: Forceable<Config>):
    Forceable<NormalizedConfig> {
  // `|| undefined` prevents environmental variables that are empty strings
  // from overriding values provided in the config object passed to start().
  const envConfig = {
    logLevel: Number(process.env.GCLOUD_TRACE_LOGLEVEL) || undefined,
    projectId: process.env.GCLOUD_PROJECT || undefined,
    serviceContext: {
      service:
          process.env.GAE_SERVICE || process.env.GAE_MODULE_NAME || undefined,
      version: process.env.GAE_VERSION || process.env.GAE_MODULE_VERSION ||
          undefined,
      minorVersion: process.env.GAE_MINOR_VERSION || undefined
    }
  };

  let envSetConfig: Config = {};
  if (!!process.env.GCLOUD_TRACE_CONFIG) {
    envSetConfig =
        require(path.resolve(process.env.GCLOUD_TRACE_CONFIG!)) as Config;
  }
  // Configuration order of precedence:
  // 1. Environment Variables
  // 2. Project Config
  // 3. Environment Variable Set Configuration File (from GCLOUD_TRACE_CONFIG)
  // 4. Default Config (as specified in './config')
  const config = extend(
      true, {[FORCE_NEW]: projectConfig[FORCE_NEW]}, defaultConfig,
      envSetConfig, projectConfig, envConfig, {plugins: {}});
  // The empty plugins object guarantees that plugins is a plain object,
  // even if it's explicitly specified in the config to be a non-object.

  // Enforce the upper limit for the label value size.
  if (config.maximumLabelValueSize >
      Constants.TRACE_SERVICE_LABEL_VALUE_LIMIT) {
    config.maximumLabelValueSize = Constants.TRACE_SERVICE_LABEL_VALUE_LIMIT;
  }
  // Clamp the logger level.
  if (config.logLevel < 0) {
    config.logLevel = 0;
  } else if (config.logLevel >= common.logger.LEVELS.length) {
    config.logLevel = common.logger.LEVELS.length - 1;
  }
  return config;
}

/**
 * Stops the Trace Agent. This disables the publicly exposed agent instance,
 * as well as any instances passed to plugins. This also prevents the Trace
 * Writer from publishing additional traces.
 */
function stop() {
  if (pluginLoader.exists()) {
    pluginLoader.get().deactivate();
  }
  if (traceAgent && traceAgent.isActive()) {
    traceAgent.disable();
  }
  if (cls.exists()) {
    cls.get().disable();
  }
  if (traceWriter.exists()) {
    traceWriter.get().stop();
  }
}

/**
 * Start the Trace agent that will make your application available for
 * tracing with Stackdriver Trace.
 *
 * @param config - Trace configuration
 *
 * @resource [Introductory video]{@link
 * https://www.youtube.com/watch?v=NCFDqeo7AeY}
 *
 * @example
 * trace.start();
 */
export function start(projectConfig?: Config): PluginTypes.TraceAgent {
  const config = initConfig(projectConfig || {});

  if (traceAgent.isActive() && !config[FORCE_NEW]) {  // already started.
    throw new Error('Cannot call start on an already started agent.');
  } else if (traceAgent.isActive()) {
    // For unit tests only.
    // Undoes initialization that occurred last time start() was called.
    stop();
  }

  if (!config.enabled) {
    return traceAgent;
  }

  const logger = common.logger({
    level: common.logger.LEVELS[config.logLevel],
    tag: '@google-cloud/trace-agent'
  });

  if (modulesLoadedBeforeTrace.length > 0) {
    logger.error(
        'TraceAgent#start: Tracing might not work as the following modules',
        'were loaded before the trace agent was initialized:',
        `[${modulesLoadedBeforeTrace.sort().join(', ')}]`);
    // Stop storing these entries in memory
    filesLoadedBeforeTrace.length = 0;
    modulesLoadedBeforeTrace.length = 0;
  }

  try {
    // Initialize context propagation mechanism.
    const m = config.clsMechanism;
    const clsConfig: Forceable<TraceCLSConfig> = {
      mechanism: m === 'auto' ? (useAH ? TraceCLSMechanism.ASYNC_HOOKS :
                                         TraceCLSMechanism.ASYNC_LISTENER) :
                                m as TraceCLSMechanism,
      [FORCE_NEW]: config[FORCE_NEW]
    };
    cls.create(logger, clsConfig).enable();

    traceWriter.create(logger, config).initialize((err) => {
      if (err) {
        stop();
      }
    });

    traceAgent.enable(logger, config);

    pluginLoader.create(logger, config).activate();
  } catch (e) {
    logger.error(
        'TraceAgent#start: Disabling the Trace Agent for the',
        `following reason: ${e.message}`);
    stop();
    return traceAgent;
  }

  if (typeof config.projectId !== 'string' &&
      typeof config.projectId !== 'undefined') {
    logger.error(
        'TraceAgent#start: config.projectId, if provided, must be a string.',
        'Disabling trace agent.');
    stop();
    return traceAgent;
  }

  // Make trace agent available globally without requiring package
  global._google_trace_agent = traceAgent;

  logger.info('TraceAgent#start: Trace Agent activated.');
  return traceAgent;
}

export function get(): PluginTypes.TraceAgent {
  return traceAgent;
}

// If the module was --require'd from the command line, start the agent.
if (module.parent && module.parent.id === 'internal/preload') {
  start();
}
