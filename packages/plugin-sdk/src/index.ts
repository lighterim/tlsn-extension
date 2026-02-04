/**
 * @tlsn/plugin-sdk
 *
 * SDK for developing and running TLSN WebAssembly plugins
 */

import { SandboxEvalCode, type SandboxOptions, loadQuickJs } from '@sebastianwessel/quickjs';
import variant from '@jitl/quickjs-ng-wasmfile-release-sync';
import { v4 as uuidv4 } from 'uuid';
import { logger, LogLevel, DEFAULT_LOG_LEVEL } from '@tlsn/common';
import {
  DomJson,
  DomOptions,
  ExecutionContext,
  InterceptedRequest,
  InterceptedRequestHeader,
  OpenWindowResponse,
  WindowMessage,
  Handler,
  PluginConfig,
  RequestPermission,
} from './types';
import deepEqual from 'fast-deep-equal';

// Module-level registry to avoid circular references in capability closures
const executionContextRegistry = new Map<string, ExecutionContext>();

// Pure function for updating execution context without `this` binding
function updateExecutionContext(
  uuid: string,
  params: {
    windowId?: number;
    plugin?: string;
    requests?: InterceptedRequest[];
    headers?: InterceptedRequestHeader[];
    context?: {
      [functionName: string]: {
        effects: any[][];
        selectors: any[][];
      };
    };
    currentContext?: string;
    stateStore?: { [key: string]: any };
  },
): void {
  const context = executionContextRegistry.get(uuid);
  if (!context) {
    throw new Error('Execution context not found');
  }
  executionContextRegistry.set(uuid, { ...context, ...params });
}

// Pure function for creating DOM JSON without `this` binding
function createDomJson(
  type: 'div' | 'button',
  param1: DomOptions | DomJson[] = {},
  param2: DomJson[] = [],
): DomJson {
  let options: DomOptions = {};
  let children: DomJson[] = [];

  if (Array.isArray(param1)) {
    children = param1;
  } else if (typeof param1 === 'object') {
    options = param1;
    children = param2;
  }

  return {
    type,
    options,
    children,
  };
}

// Pure function for creating useEffect hook without `this` binding
function makeUseEffect(
  uuid: string,
  context: {
    [functionName: string]: {
      effects: any[][];
      selectors: any[][];
    };
  },
) {
  return (effect: () => void, deps: any[]) => {
    const executionContext = executionContextRegistry.get(uuid);
    if (!executionContext) {
      throw new Error('Execution context not found');
    }
    const functionName = executionContext.currentContext;
    context[functionName] = context[functionName] || {
      effects: [],
      selectors: [],
    };
    const effects = context[functionName].effects;
    const lastDeps = executionContext.context[functionName]?.effects[effects.length];
    effects.push(deps);
    if (deepEqual(lastDeps, deps)) {
      return;
    }
    effect();
  };
}

// Pure function for creating useRequests hook without `this` binding
function makeUseRequests(
  uuid: string,
  context: {
    [functionName: string]: {
      effects: any[][];
      selectors: any[][];
    };
  },
) {
  return (filterFn: (requests: InterceptedRequest[]) => InterceptedRequest[]) => {
    const executionContext = executionContextRegistry.get(uuid);
    if (!executionContext) {
      throw new Error('Execution context not found');
    }
    const functionName = executionContext.currentContext;
    context[functionName] = context[functionName] || {
      effects: [],
      selectors: [],
    };
    const selectors = context[functionName].selectors;
    const requests = JSON.parse(JSON.stringify(executionContext.requests || []));
    const result = filterFn(requests);
    selectors.push(result);
    return result;
  };
}

// Pure function for creating useHeaders hook without `this` binding
function makeUseHeaders(
  uuid: string,
  context: {
    [functionName: string]: {
      effects: any[][];
      selectors: any[][];
    };
  },
) {
  return (filterFn: (headers: InterceptedRequestHeader[]) => InterceptedRequestHeader[]) => {
    console.log(`[plugin-sdk] useHeaders called (uuid=${uuid})`);
    const executionContext = executionContextRegistry.get(uuid);
    if (!executionContext) {
      console.error(`[plugin-sdk] useHeaders: Execution context not found for uuid=${uuid}`);
      throw new Error('Execution context not found');
    }
    const functionName = executionContext.currentContext;
    console.log(`[plugin-sdk] useHeaders: currentContext="${functionName}", headers count=${executionContext.headers?.length || 0}`);
    context[functionName] = context[functionName] || {
      effects: [],
      selectors: [],
    };
    const selectors = context[functionName].selectors;
    // Serialize headers to break circular references
    console.log(`[plugin-sdk] useHeaders: Serializing headers...`);
    const headers = JSON.parse(JSON.stringify(executionContext.headers || []));
    console.log(`[plugin-sdk] useHeaders: Headers serialized, count=${headers.length}, calling filterFn...`);
    const result = filterFn(headers);
    console.log(`[plugin-sdk] useHeaders: filterFn returned, result count=${result?.length || 0}`);

    // Validate that filterFn returned an array
    if (result === undefined) {
      throw new Error(`useHeaders: filter function returned undefined. expect an erray`);
    }
    if (!Array.isArray(result)) {
      throw new Error(`useHeaders: filter function must return an array, got ${typeof result}. `);
    }

    selectors.push(result);
    return result;
  };
}

function makeUseState(
  uuid: string,
  stateStore: { [key: string]: any },
  _eventEmitter: {
    emit: (message: any) => void;
  },
) {
  return (key: string, defaultValue: any) => {
    const startTime = Date.now();
    console.log(`[plugin-sdk] useState called: key="${key}", uuid=${uuid}, defaultValue=`, defaultValue);
    try {
      const executionContext = executionContextRegistry.get(uuid);
      if (!executionContext) {
        console.error(`[plugin-sdk] useState: Execution context not found for uuid=${uuid}`);
        throw new Error('Execution context not found');
      }
      if (!stateStore[key] && defaultValue !== undefined) {
        stateStore[key] = defaultValue;
        console.log(`[plugin-sdk] useState: Initialized key="${key}" with default value:`, defaultValue);
      }
      const value = stateStore[key];
      const valueType = typeof value;
      const valueString = valueType === 'object' ? JSON.stringify(value) : String(value);
      console.log(`[plugin-sdk] useState: Returning value for key="${key}":`, value, `(type: ${valueType}, string: ${valueString.substring(0, 100)})`);
      console.log(`[plugin-sdk] useState: Completed in ${Date.now() - startTime}ms`);
      
      // CRITICAL: Ensure the return value is properly serializable for QuickJS
      // QuickJS may have issues with certain value types or circular references
      // Force serialization to break any potential circular references
      let returnValue = value;
      try {
        // For primitive types, return as-is
        if (valueType === 'boolean' || valueType === 'number' || valueType === 'string' || value === null || value === undefined) {
          returnValue = value;
        } else {
          // For objects/arrays, ensure they're serializable
          const serialized = JSON.parse(JSON.stringify(value));
          returnValue = serialized;
        }
      } catch (serializeError) {
        console.warn(`[plugin-sdk] useState: Failed to serialize return value, using original:`, serializeError);
        returnValue = value;
      }
      
      console.log(`[plugin-sdk] useState: Returning serialized value:`, returnValue);
      // eventEmitter.emit({
      //   type: 'TO_BG_RE_RENDER_PLUGIN_UI',
      //   windowId: executionContextRegistry.get(uuid)?.windowId || 0,
      // });
      return returnValue;
    } catch (error) {
      console.error(`[plugin-sdk] useState: Error in useState for key="${key}":`, error);
      throw error;
    }
  };
}

function makeSetState(
  uuid: string,
  stateStore: { [key: string]: any },
  eventEmitter: {
    emit: (message: any) => void;
  },
) {
  return (key: string, value: any) => {
    console.log(`[plugin-sdk] setState called: key="${key}", value=`, value, `uuid=${uuid}`);
    const executionContext = executionContextRegistry.get(uuid);
    if (!executionContext) {
      console.error(`[plugin-sdk] setState: Execution context not found for uuid=${uuid}`);
      throw new Error('Execution context not found');
    }
    stateStore[key] = value;
    console.log(`[plugin-sdk] setState: State updated for key="${key}"`);
    if (deepEqual(stateStore, executionContext.stateStore)) {
      console.log(`[plugin-sdk] setState: State unchanged, skipping re-render`);
      return;
    }

    console.log(`[plugin-sdk] setState: Emitting RE_RENDER_PLUGIN_UI for windowId=${executionContext.windowId}`);
    eventEmitter.emit({
      type: 'TO_BG_RE_RENDER_PLUGIN_UI',
      windowId: executionContextRegistry.get(uuid)?.windowId || 0,
    });
    console.log(`[plugin-sdk] setState: Completed for key="${key}"`);
  };
}

// Pure function for creating openWindow without `this` binding
function makeOpenWindow(
  uuid: string,
  eventEmitter: {
    addListener: (listener: (message: WindowMessage) => void) => void;
    removeListener: (listener: (message: WindowMessage) => void) => void;
  },
  onOpenWindow: (
    url: string,
    options?: {
      width?: number;
      height?: number;
      showOverlay?: boolean;
    },
  ) => Promise<OpenWindowResponse>,
  _onCloseWindow: (windowId: number) => void,
) {
  return async (
    url: string,
    options?: {
      width?: number;
      height?: number;
      showOverlay?: boolean;
    },
  ): Promise<{ windowId: number; uuid: string; tabId: number }> => {
    if (!url || typeof url !== 'string') {
      throw new Error('URL must be a non-empty string');
    }

    try {
      const response = await onOpenWindow(url, options);

      // Check if response indicates an error
      if (response?.type === 'WINDOW_ERROR') {
        throw new Error(
          response.payload?.details || response.payload?.error || 'Failed to open window',
        );
      }

      // Return window info from successful response
      if (response?.type === 'WINDOW_OPENED' && response.payload) {
        updateExecutionContext(uuid, {
          windowId: response.payload.windowId,
        });

        const onMessage = async (message: any) => {
          // Only log PLUGIN_UI_CLICK messages to console (other messages are too frequent)
          if (message.type === 'PLUGIN_UI_CLICK') {
            console.log(
              `[plugin-sdk] eventEmitter listener received: type=${message.type}, windowId=${message.windowId}, uuid=${uuid}`,
            );
          }
          // Other messages logged at debug level only
          logger.debug(
            `[plugin-sdk] eventEmitter listener received: type=${message.type}, windowId=${message.windowId}, uuid=${uuid}`,
          );

          if (message.type === 'REQUEST_INTERCEPTED') {
            const request = message.request;
            const executionContext = executionContextRegistry.get(uuid);
            if (!executionContext) {
              throw new Error('Execution context not found');
            }
            updateExecutionContext(uuid, {
              requests: [...(executionContext.requests || []), request],
            });
            executionContext.main();
          }

          if (message.type === 'HEADER_INTERCEPTED') {
            const header = message.header;
            const executionContext = executionContextRegistry.get(uuid);
            if (!executionContext) {
              throw new Error('Execution context not found');
            }
            updateExecutionContext(uuid, {
              headers: [...(executionContext.headers || []), header],
            });
            executionContext.main();
          }

          if (message.type === 'PLUGIN_UI_CLICK') {
            // Only process messages forwarded from Background (to avoid duplicate processing)
            // Content Script sends to both Background and Offscreen, Background forwards with __fromBackground flag
            if (!message.__fromBackground) {
              console.log(
                `[plugin-sdk] Ignoring PLUGIN_UI_CLICK (direct from Content Script, Background will forward): onclick="${message.onclick}", windowId=${message.windowId}`,
              );
              logger.debug(
                `[plugin-sdk] Ignoring PLUGIN_UI_CLICK (direct from Content Script, Background will forward)`,
              );
              return; // Skip processing, wait for Background to forward it
            }

            console.log(
              `[plugin-sdk] PLUGIN_UI_CLICK handler entered: onclick="${message.onclick}", windowId=${message.windowId}, current uuid=${uuid}`,
            );
            logger.info(
              `[plugin-sdk] PLUGIN_UI_CLICK received: onclick="${message.onclick}", windowId=${message.windowId}, current uuid=${uuid}`,
            );

            // Find execution context by windowId if uuid doesn't match
            let targetUuid = uuid;
            let executionContext = executionContextRegistry.get(uuid);
            console.log(
              `[plugin-sdk] Initial execution context lookup: uuid=${uuid}, found=${!!executionContext}`,
            );

            // If execution context not found by uuid, try to find by windowId
            if (!executionContext && message.windowId) {
              logger.debug(
                `[plugin-sdk] Execution context not found for uuid=${uuid}, searching by windowId=${message.windowId}...`,
              );
              for (const [ctxUuid, ctx] of executionContextRegistry.entries()) {
                if (ctx.windowId === message.windowId) {
                  targetUuid = ctxUuid;
                  executionContext = ctx;
                  logger.info(
                    `[plugin-sdk] Found execution context by windowId: uuid=${targetUuid}, windowId=${message.windowId}`,
                  );
                  break;
                }
              }
            }

            if (!executionContext) {
              const availableContexts = Array.from(
                executionContextRegistry.entries(),
              ).map(([u, ctx]) => ({
                uuid: u,
                windowId: ctx.windowId,
                callbacks: Object.keys(ctx.callbacks),
              }));
              console.error(
                `[plugin-sdk] Execution context not found for uuid=${uuid}, windowId=${message.windowId}. Available contexts:`,
                availableContexts,
              );
              logger.error(
                `[plugin-sdk] Execution context not found for uuid=${uuid}, windowId=${message.windowId}. Available contexts:`,
                availableContexts,
              );
              throw new Error(
                `Execution context not found for uuid=${uuid}, windowId=${message.windowId}`,
              );
            }
            console.log(
              `[plugin-sdk] Found execution context (uuid=${targetUuid}), available callbacks:`,
              Object.keys(executionContext.callbacks),
            );
            logger.debug(
              `[plugin-sdk] Found execution context (uuid=${targetUuid}), available callbacks:`,
              Object.keys(executionContext.callbacks),
            );
            const cb = executionContext.callbacks[message.onclick];

            console.log(`[plugin-sdk] Callback for "${message.onclick}":`, cb);
            logger.debug(`[plugin-sdk] Callback for "${message.onclick}":`, cb);
            if (cb) {
              console.log(
                `[plugin-sdk] Executing callback "${message.onclick}" (uuid=${targetUuid})...`,
              );
              logger.info(
                `[plugin-sdk] Executing callback "${message.onclick}" (uuid=${targetUuid})...`,
              );
              try {
                console.log(
                  `[plugin-sdk] Updating execution context before callback execution (uuid=${targetUuid})`,
                );
                updateExecutionContext(targetUuid, {
                  currentContext: message.onclick,
                });
                console.log(
                  `[plugin-sdk] Callback "${message.onclick}" started (uuid=${targetUuid})`,
                );
                logger.debug(
                  `[plugin-sdk] Callback "${message.onclick}" started (uuid=${targetUuid})`,
                );

                // Add timeout to detect hanging callbacks
                // KNOWN ISSUE: QuickJS may hang when executing callbacks that use hooks (useState, useHeaders, etc.)
                // This is a known limitation documented in executePlugin.test.ts
                // The callback may return a Promise that never resolves if QuickJS encounters
                // issues with circular references or async function execution after hook calls
                const timeoutPromise = new Promise((_, reject) => {
                  setTimeout(() => {
                    reject(
                      new Error(
                        `Callback "${message.onclick}" timed out after 30 seconds. ` +
                        `This is a known QuickJS limitation when executing callbacks that use hooks. ` +
                        `The callback may hang after calling useState/useHeaders/useRequests. ` +
                        `Please check the plugin code and consider refactoring to avoid early returns after hook calls.`,
                      ),
                    );
                  }, 30000); // 30 second timeout
                });

                console.log(
                  `[plugin-sdk] About to execute callback "${message.onclick}" (uuid=${targetUuid})...`,
                );
                console.log(`[plugin-sdk] Callback function type:`, typeof cb);
                console.log(`[plugin-sdk] Callback is async:`, cb.constructor.name === 'AsyncFunction' || cb.toString().includes('async'));
                
                // Wrap callback execution to catch any synchronous errors
                // Note: This is a known QuickJS limitation - callbacks may hang or throw
                // "Maximum call stack size exceeded" errors due to circular references
                const wrappedCallback = async () => {
                  try {
                    console.log(`[plugin-sdk] Calling callback function (QuickJS sandbox)...`);
                    console.log(`[plugin-sdk] Callback function toString (first 200 chars):`, cb.toString().substring(0, 200));
                    
                    // Add a small delay to allow QuickJS to process
                    await new Promise(resolve => setTimeout(resolve, 10));
                    
                    console.log(`[plugin-sdk] About to call cb() - creating promise...`);
                    
                    // Try to detect if cb() throws synchronously
                    let callbackPromise: Promise<any>;
                    try {
                      // CRITICAL: QuickJS may hang when executing callbacks that use hooks
                      // This is a known limitation documented in executePlugin.test.ts
                      // The callback may return a Promise that never resolves if QuickJS encounters
                      // issues with circular references or async function execution
                      callbackPromise = cb();
                      console.log(`[plugin-sdk] cb() called successfully, got promise:`, callbackPromise);
                      console.log(`[plugin-sdk] Promise type:`, callbackPromise?.constructor?.name);
                      console.log(`[plugin-sdk] Is promise:`, callbackPromise instanceof Promise);
                      console.log(`[plugin-sdk] Promise state:`, callbackPromise?.then ? 'thenable' : 'not thenable');
                      
                      // Check if this is a QuickJS Promise wrapper
                      const promiseString = String(callbackPromise);
                      if (promiseString.includes('quickjs') || promiseString.includes('Scope')) {
                        console.warn(`[plugin-sdk] WARNING: Callback returned a QuickJS Promise wrapper - this may hang due to known QuickJS limitations`);
                      }
                    } catch (syncError) {
                      console.error(`[plugin-sdk] cb() threw synchronously:`, syncError);
                      throw syncError;
                    }
                    
                    // Verify it's actually a Promise
                    if (!callbackPromise || typeof callbackPromise.then !== 'function') {
                      console.error(`[plugin-sdk] cb() did not return a Promise! Got:`, typeof callbackPromise, callbackPromise);
                      throw new Error(`Callback did not return a Promise, got: ${typeof callbackPromise}`);
                    }
                    
                    // Add periodic logging to track if promise is hanging
                    let promiseResolved = false;
                    const startTime = Date.now();
                    let mainCallCount = 0;
                    const executionContext = executionContextRegistry.get(targetUuid);
                    
                    // Track main() calls to detect if callback actually executed
                    const originalMain = executionContext?.main;
                    if (originalMain) {
                      const wrappedMain = (...args: any[]) => {
                        mainCallCount++;
                        console.log(`[plugin-sdk] main() called (count: ${mainCallCount}) - callback may have completed`);
                        return originalMain.apply(executionContext, args);
                      };
                      // Note: We can't easily intercept main() calls without modifying the execution context
                      // This is just for logging purposes
                    }
                    
                    const logInterval = setInterval(() => {
                      if (!promiseResolved) {
                        const elapsed = Date.now() - startTime;
                        console.log(`[plugin-sdk] Callback promise still pending after ${elapsed}ms...`);
                        // Try to get more info about the promise state
                        console.log(`[plugin-sdk] Promise details:`, {
                          hasThen: typeof callbackPromise.then === 'function',
                          hasCatch: typeof callbackPromise.catch === 'function',
                          hasFinally: typeof callbackPromise.finally === 'function',
                        });
                        
                        // WORKAROUND: If promise has been pending for more than 2 seconds and main() was called,
                        // it's likely the callback completed but Promise didn't resolve (QuickJS bug)
                        // Try to manually resolve the promise
                        if (elapsed > 2000 && mainCallCount > 0) {
                          console.warn(`[plugin-sdk] WORKAROUND: Promise pending for ${elapsed}ms but main() was called - callback likely completed. Attempting manual resolve...`);
                          // Try to resolve manually - this may not work but worth trying
                          try {
                            // Check if promise has a resolve method (unlikely but worth checking)
                            if (typeof (callbackPromise as any).resolve === 'function') {
                              (callbackPromise as any).resolve(undefined);
                            }
                          } catch (e) {
                            console.warn(`[plugin-sdk] Could not manually resolve promise:`, e);
                          }
                        }
                      }
                    }, 5000); // Log every 5 seconds instead of every second
                    
                    try {
                      // Add a race condition check - if promise doesn't resolve quickly, log warning
                      const quickCheck = Promise.race([
                        callbackPromise,
                        new Promise((resolve) => setTimeout(() => resolve('TIMEOUT_CHECK'), 100)),
                      ]);
                      
                      const quickResult = await quickCheck;
                      if (quickResult === 'TIMEOUT_CHECK') {
                        console.warn(`[plugin-sdk] Callback promise did not resolve within 100ms - likely hanging`);
                        
                        // WORKAROUND ATTEMPT: For async functions that return early (e.g., `if (condition) return;`),
                        // QuickJS may not properly resolve the Promise. This is a known QuickJS limitation.
                        // We'll wait longer (2 seconds) to see if callback continues executing (e.g., calling prove())
                        // If no activity detected, assume it's an early return case
                        console.log(`[plugin-sdk] Waiting 2 seconds to detect if callback continues executing...`);
                        const extendedCheck = Promise.race([
                          callbackPromise,
                          new Promise((resolve) => setTimeout(() => resolve('EXTENDED_TIMEOUT'), 2000)),
                        ]);
                        
                        // Track if we see any activity (setState, prove calls, etc.)
                        let activityDetected = false;
                        const activityCheckInterval = setInterval(() => {
                          // Check if execution context changed (indicating callback is still running)
                          const currentContext = executionContextRegistry.get(targetUuid);
                          if (currentContext?.currentContext === message.onclick) {
                            // Callback context is still active, might be executing
                            activityDetected = true;
                            console.log(`[plugin-sdk] Activity detected: callback context still active`);
                          }
                        }, 200);
                        
                        const extendedResult = await extendedCheck;
                        clearInterval(activityCheckInterval);
                        
                        if (extendedResult === 'EXTENDED_TIMEOUT') {
                          // Still not resolved after 2 seconds
                          if (activityDetected) {
                            console.warn(`[plugin-sdk] WORKAROUND: Promise still pending after 2s but activity detected - callback may still be executing`);
                            console.warn(`[plugin-sdk] Waiting additional 3 seconds for callback to complete...`);
                            // Wait a bit more if activity was detected
                            const finalCheck = Promise.race([
                              callbackPromise,
                              new Promise((resolve) => setTimeout(() => resolve('FINAL_TIMEOUT'), 3000)),
                            ]);
                            const finalResult = await finalCheck;
                            if (finalResult === 'FINAL_TIMEOUT') {
                              console.warn(`[plugin-sdk] WORKAROUND: Callback still pending after 5s total - assuming completed`);
                              promiseResolved = true;
                              clearInterval(logInterval);
                              return undefined;
                            } else {
                              promiseResolved = true;
                              clearInterval(logInterval);
                              console.log(`[plugin-sdk] Callback function returned (after extended wait):`, finalResult);
                              return finalResult;
                            }
                          } else {
                            // No activity detected - likely early return or complete hang
                            console.warn(`[plugin-sdk] WORKAROUND: Promise still pending after 2s with no activity - assuming callback completed (early return case)`);
                            console.warn(`[plugin-sdk] This is a known QuickJS limitation with async function execution after hook calls`);
                            console.warn(`[plugin-sdk] NOTE: If the callback should continue executing (e.g., calling prove()), it may have been interrupted.`);
                            console.warn(`[plugin-sdk] Consider refactoring the callback to avoid early returns after hook calls.`);
                            promiseResolved = true;
                            clearInterval(logInterval);
                            // Return undefined as if the callback returned early
                            // This workaround allows the callback to complete without 30-second timeout
                            return undefined;
                          }
                        } else {
                          // Promise resolved naturally
                          promiseResolved = true;
                          clearInterval(logInterval);
                          console.log(`[plugin-sdk] Callback function returned (after extended wait):`, extendedResult);
                          return extendedResult;
                        }
                      }
                      
                      const callbackResult = await callbackPromise;
                      promiseResolved = true;
                      clearInterval(logInterval);
                      console.log(`[plugin-sdk] Callback function returned:`, callbackResult);
                      return callbackResult;
                    } catch (promiseError) {
                      promiseResolved = true;
                      clearInterval(logInterval);
                      console.error(`[plugin-sdk] Callback promise rejected:`, promiseError);
                      throw promiseError;
                    }
                  } catch (error) {
                    console.error(`[plugin-sdk] Callback function threw error:`, error);
                    console.error(`[plugin-sdk] Error details:`, {
                      name: error instanceof Error ? error.name : 'Unknown',
                      message: error instanceof Error ? error.message : String(error),
                      stack: error instanceof Error ? error.stack : 'No stack',
                    });
                    throw error;
                  }
                };
                
                console.log(`[plugin-sdk] Starting Promise.race with timeout (30s)...`);
                const result = await Promise.race([wrappedCallback(), timeoutPromise]);
                console.log(
                  `[plugin-sdk] Callback "${message.onclick}" completed (uuid=${targetUuid}), result:`,
                  result,
                );
                updateExecutionContext(targetUuid, {
                  currentContext: '',
                });
                logger.info(
                  `[plugin-sdk] Callback "${message.onclick}" completed successfully (uuid=${targetUuid}), result:`,
                  result,
                );
              } catch (error) {
                console.error(
                  `[plugin-sdk] Callback "${message.onclick}" failed (uuid=${targetUuid}):`,
                  error,
                );
                console.error(
                  `[plugin-sdk] Error type:`,
                  error instanceof Error ? error.constructor.name : typeof error,
                );
                console.error(
                  `[plugin-sdk] Error message:`,
                  error instanceof Error ? error.message : String(error),
                );
                console.error(
                  `[plugin-sdk] Error stack:`,
                  error instanceof Error ? error.stack : 'No stack trace',
                );
                updateExecutionContext(targetUuid, {
                  currentContext: '',
                });
                logger.error(
                  `[plugin-sdk] Callback "${message.onclick}" failed (uuid=${targetUuid}):`,
                  error,
                );
                throw error;
              }
            } else {
              logger.warn(
                `[plugin-sdk] Callback "${message.onclick}" not found in callbacks (uuid=${targetUuid})`,
              );
            }
          }

          if (message.type === 'RE_RENDER_PLUGIN_UI') {
            logger.debug('[makeOpenWindow] RE_RENDER_PLUGIN_UI', message.windowId);
            const executionContext = executionContextRegistry.get(uuid);
            if (!executionContext) {
              throw new Error('Execution context not found');
            }
            executionContext.main(true);
          }

          if (message.type === 'WINDOW_CLOSED') {
            eventEmitter.removeListener(onMessage);
          }
        };

        eventEmitter.addListener(onMessage);

        return {
          windowId: response.payload.windowId,
          uuid: response.payload.uuid,
          tabId: response.payload.tabId,
        };
      }

      throw new Error('Invalid response from background script');
    } catch (error) {
      logger.error('[makeOpenWindow] Failed to open window:', error);
      throw error;
    }
  };
}

// Export Parser and its types
export {
  Parser,
  type Range,
  type ParsedValue,
  type ParsedHeader,
  type ParsedRequest,
  type ParsedResponse,
  type HeaderRangeOptions,
  type BodyRangeOptions,
} from './parser';

export class Host {
  private capabilities: Map<string, (...args: any[]) => any> = new Map();
  private onProve: (
    requestOptions: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    },
    proverOptions: {
      verifierUrl: string;
      proxyUrl: string;
      maxRecvData?: number;
      maxSentData?: number;
      handlers: Handler[];
    },
  ) => Promise<any>;
  private onRenderPluginUi: (windowId: number, result: DomJson) => void;
  private onCloseWindow: (windowId: number) => void;
  private onOpenWindow: (
    url: string,
    options?: {
      width?: number;
      height?: number;
      showOverlay?: boolean;
    },
  ) => Promise<OpenWindowResponse>;

  constructor(options: {
    onProve: (
      requestOptions: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body?: string;
      },
      proverOptions: {
        verifierUrl: string;
        proxyUrl: string;
        maxRecvData?: number;
        maxSentData?: number;
        handlers: Handler[];
      },
    ) => Promise<any>;
    onRenderPluginUi: (windowId: number, result: DomJson) => void;
    onCloseWindow: (windowId: number) => void;
    onOpenWindow: (
      url: string,
      options?: {
        width?: number;
        height?: number;
        showOverlay?: boolean;
      },
    ) => Promise<OpenWindowResponse>;
    logLevel?: LogLevel;
  }) {
    this.onProve = options.onProve;
    this.onRenderPluginUi = options.onRenderPluginUi;
    this.onCloseWindow = options.onCloseWindow;
    this.onOpenWindow = options.onOpenWindow;

    // Initialize logger with provided level or default to WARN
    logger.init(options.logLevel ?? DEFAULT_LOG_LEVEL);
  }

  addCapability(name: string, handler: (...args: any[]) => any): void {
    this.capabilities.set(name, handler);
  }

  async createEvalCode(capabilities?: { [method: string]: (...args: any[]) => any }): Promise<{
    eval: (code: string) => Promise<any>;
    dispose: () => void;
  }> {
    const { runSandboxed } = await loadQuickJs(variant);

    const options: SandboxOptions = {
      allowFetch: false,
      allowFs: false,
      maxStackSize: 0,
      env: {
        ...Object.fromEntries(this.capabilities),
        ...(capabilities || {}),
      },
    };

    let evalCode: SandboxEvalCode | null = null;
    let disposeCallback: (() => void) | null = null;

    // Start sandbox and keep it alive
    // Don't await this - we want it to keep running
    runSandboxed(async (sandbox) => {
      evalCode = sandbox.evalCode;

      // Keep the sandbox alive until dispose is called
      // The runtime won't be disposed until this promise resolves
      return new Promise<void>((resolve) => {
        disposeCallback = resolve;
      });
    }, options);

    // Wait for evalCode to be ready
    while (!evalCode) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Return evalCode and dispose function
    return {
      eval: async (code: string) => {
        const result = await evalCode!(code);

        if (!result.ok) {
          const err = new Error(result.error.message);
          err.name = result.error.name;
          err.stack = result.error.stack;
          throw err;
        }

        return result.data;
      },
      dispose: () => {
        if (disposeCallback) {
          disposeCallback();
          disposeCallback = null;
        }
      },
    };
  }

  updateExecutionContext(
    uuid: string,
    params: {
      windowId?: number;
      plugin?: string;
      requests?: InterceptedRequest[];
      headers?: InterceptedRequestHeader[];
      context?: {
        [functionName: string]: {
          effects: any[][];
          selectors: any[][];
        };
      };
      currentContext?: string;
    },
  ): void {
    updateExecutionContext(uuid, params);
  }

  async getPluginConfig(code: string): Promise<any> {
    const sandbox = await this.createEvalCode();
    const exportedCode = await sandbox.eval(`
const div = env.div;
const button = env.button;
const openWindow = env.openWindow;
const useEffect = env.useEffect;
const useRequests = env.useRequests;
const useHeaders = env.useHeaders;
const createProver = env.createProver;
const sendRequest = env.sendRequest;
const transcript = env.transcript;
const subtractRanges = env.subtractRanges;
const mapStringToRange = env.mapStringToRange;
const reveal = env.reveal;
const getResponse = env.getResponse;
const closeWindow = env.closeWindow;
const done = env.done;
${code};
`);

    const { config } = exportedCode;
    return config;
  }

  async executePlugin(
    code: string,
    {
      eventEmitter,
    }: {
      eventEmitter: {
        addListener: (listener: (message: WindowMessage) => void) => void;
        removeListener: (listener: (message: WindowMessage) => void) => void;
        emit: (message: WindowMessage) => void;
      };
    },
  ): Promise<unknown> {
    const uuid = uuidv4();

    const context: {
      [functionName: string]: {
        effects: any[][];
        selectors: any[][];
      };
    } = {};

    const stateStore: { [key: string]: any } = {};

    let doneResolve: (args?: any[]) => void;

    const donePromise = new Promise((resolve) => {
      doneResolve = resolve;
    });

    /**
     * The sandbox is a sandboxed environment that is used to execute the plugin code.
     * It is created using the createEvalCode method from the plugin-sdk.
     * The sandbox is created with the following capabilities:
     * - div: a function that creates a div element
     * - button: a function that creates a button element
     * - openWindow: a function that opens a new window
     * - useEffect: a function that creates a useEffect hook
     * - useRequests: a function that creates a useRequests hook
     * - useHeaders: a function that creates a useHeaders hook
     * - subtractRanges: a function that subtracts ranges
     * - mapStringToRange: a function that maps a string to a range
     * - createProver: a function that creates a prover
     * - sendRequest: a function that sends a request
     * - transcript: a function that returns the transcript
     * - reveal: a function that reveals a commit
     * - getResponse: a function that returns the verification response (sent/received data) or null
     * - closeWindow: a function that closes a window by windowId
     * - done: a function that completes the session and closes the window
     */
    // Create pure functions without `this` bindings to avoid circular references
    const onCloseWindow = this.onCloseWindow;
    const onRenderPluginUi = this.onRenderPluginUi;
    const onOpenWindow = this.onOpenWindow;
    const onProve = this.onProve;

    const sandbox = await this.createEvalCode({
      div: (param1?: DomOptions | DomJson[], param2?: DomJson[]) =>
        createDomJson('div', param1, param2),
      button: (param1?: DomOptions | DomJson[], param2?: DomJson[]) =>
        createDomJson('button', param1, param2),
      openWindow: makeOpenWindow(uuid, eventEmitter, onOpenWindow, onCloseWindow),
      useEffect: makeUseEffect(uuid, context),
      useRequests: makeUseRequests(uuid, context),
      useHeaders: makeUseHeaders(uuid, context),
      useState: makeUseState(uuid, stateStore, eventEmitter),
      setState: makeSetState(uuid, stateStore, eventEmitter),
      prove: onProve,
      done: (args?: any[]) => {
        // Close the window if it exists
        const context = executionContextRegistry.get(uuid);
        if (context?.windowId) {
          onCloseWindow(context.windowId);
        }
        executionContextRegistry.delete(uuid);
        doneResolve(args);
      },
    });

    const exportedCode = await sandbox.eval(`
const div = env.div;
const button = env.button;
const openWindow = env.openWindow;
const useEffect = env.useEffect;
const useRequests = env.useRequests;
const useHeaders = env.useHeaders;
const useState = env.useState;
const setState = env.setState;
const prove = env.prove;
const closeWindow = env.closeWindow;
const done = env.done;
${code};
`);

    const { main: mainFn, ...args } = exportedCode;

    if (typeof mainFn !== 'function') {
      throw new Error('Main function not found');
    }

    const callbacks: {
      [callbackName: string]: () => Promise<void>;
    } = {};

    for (const key in args) {
      if (typeof args[key] === 'function') {
        callbacks[key] = args[key];
      }
    }

    let json: DomJson | null = null;

    const main = (force = false) => {
      try {
        updateExecutionContext(uuid, {
          currentContext: 'main',
        });

        let result = mainFn();
        const lastSelectors = executionContextRegistry.get(uuid)?.context['main']?.selectors;
        const selectors = context['main']?.selectors;
        const lastStateStore = executionContextRegistry.get(uuid)?.stateStore;

        if (
          !force &&
          deepEqual(lastSelectors, selectors) &&
          deepEqual(lastStateStore, stateStore)
        ) {
          result = null;
        }

        updateExecutionContext(uuid, {
          currentContext: '',
          context: {
            ...executionContextRegistry.get(uuid)?.context,
            main: {
              effects: JSON.parse(JSON.stringify(context['main']?.effects)),
              selectors: JSON.parse(JSON.stringify(context['main']?.selectors)),
            },
          },
          stateStore: JSON.parse(JSON.stringify(stateStore)),
        });

        if (context['main']) {
          context['main'].effects.length = 0;
          context['main'].selectors.length = 0;
        }

        if (result) {
          logger.debug('Main function executed:', result);

          logger.debug(
            'executionContextRegistry.get(uuid)?.windowId',
            executionContextRegistry.get(uuid)?.windowId,
          );

          json = result;
          waitForWindow(async () => executionContextRegistry.get(uuid)?.windowId).then(
            (windowId: number) => {
              logger.debug('render result', json as DomJson);
              onRenderPluginUi(windowId!, json as DomJson);
            },
          );
        }

        return result;
      } catch (error) {
        logger.error('Main function error:', error);
        sandbox.dispose();
        return null;
      }
    };

    executionContextRegistry.set(uuid, {
      id: uuid,
      plugin: code,
      pluginUrl: '',
      context: {},
      currentContext: '',
      sandbox,
      main: main,
      callbacks: callbacks,
      stateStore: {},
    });

    main();

    return donePromise;
  }

  /**
   * Public method for creating DOM JSON
   * Delegates to the pure module-level function
   */
  createDomJson = (
    type: 'div' | 'button',
    param1: DomOptions | DomJson[] = {},
    param2: DomJson[] = [],
  ): DomJson => {
    return createDomJson(type, param1, param2);
  };
}

async function waitForWindow(callback: () => Promise<any>, retry = 0): Promise<any | null> {
  const resp = await callback();

  if (resp) return resp;

  if (retry < 100) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return waitForWindow(callback, retry + 1);
  }

  return null;
}

/**
 * Extract plugin configuration from plugin code without executing it.
 * Uses regex-based parsing to extract the config object from the source code.
 *
 * Note: This regex-based approach cannot extract complex fields like arrays
 * (requests, urls). For full config extraction including permissions, use
 * Host.getPluginConfig() which uses the QuickJS sandbox.
 *
 * @param code - The plugin source code
 * @returns The plugin config object, or null if extraction fails
 */
export async function extractConfig(code: string): Promise<PluginConfig | null> {
  try {
    // Pattern to match config object definition:
    // const config = { name: '...', description: '...' }
    // or
    // const config = { name: "...", description: "..." }
    const configPattern =
      /const\s+config\s*=\s*\{([^}]*name\s*:\s*['"`]([^'"`]+)['"`][^}]*description\s*:\s*['"`]([^'"`]+)['"`][^}]*|[^}]*description\s*:\s*['"`]([^'"`]+)['"`][^}]*name\s*:\s*['"`]([^'"`]+)['"`][^}]*)\}/s;

    const match = code.match(configPattern);

    if (!match) {
      return null;
    }

    // Extract name and description (could be in either order)
    const name = match[2] || match[5];
    const description = match[3] || match[4];

    if (!name) {
      return null;
    }

    const config: PluginConfig = {
      name,
      description: description || 'No description provided',
    };

    // Try to extract optional version
    const versionMatch = code.match(/version\s*:\s*['"`]([^'"`]+)['"`]/);
    if (versionMatch) {
      config.version = versionMatch[1];
    }

    // Try to extract optional author
    const authorMatch = code.match(/author\s*:\s*['"`]([^'"`]+)['"`]/);
    if (authorMatch) {
      config.author = authorMatch[1];
    }

    return config;
  } catch (error) {
    logger.error('[extractConfig] Failed to extract plugin config:', error);
    return null;
  }
}

// Export types
export type { PluginConfig, RequestPermission };

// Re-export LogLevel for consumers
export { LogLevel } from '@tlsn/common';

// Default export
export default Host;
