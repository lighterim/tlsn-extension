import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionManager } from '../../offscreen/SessionManager';
import { logger } from '@tlsn/common';
import { getStoredLogLevel } from '../../utils/logLevelStorage';

const OffscreenApp: React.FC = () => {
  useEffect(() => {
    // Initialize logger with stored log level
    getStoredLogLevel().then((level) => {
      logger.init(level);
      logger.info('Offscreen document loaded');
    });

    // Initialize SessionManager
    const sessionManager = new SessionManager();
    logger.debug('SessionManager initialized in Offscreen');

    // Listen for messages from background script
    console.log('[Offscreen] Registering onMessage listener...');
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      // Only log important messages to console (REQUEST_INTERCEPTED/HEADER_INTERCEPTED are too frequent)
      const importantTypes = [
        'PLUGIN_UI_CLICK',
        'EXEC_CODE_OFFSCREEN',
        'EXTRACT_CONFIG',
        'PLUGIN_CONFIRM_RESPONSE',
      ];
      if (importantTypes.includes(request.type)) {
        console.log(
          `[Offscreen] Message received: type=${request.type}`,
          request,
        );
      }
      // All messages logged at debug level
      logger.debug(
        `[Offscreen] Message received: type=${request.type}`,
        request,
      );

      // PLUGIN_UI_CLICK messages are handled by plugin-sdk's eventEmitter listener
      // registered in SessionManager.executePlugin -> Host.executePlugin -> makeOpenWindow
      // We only process messages forwarded from Background (with __fromBackground flag)
      // to avoid duplicate processing (Content Script sends to both Background and Offscreen)
      if (request.type === 'PLUGIN_UI_CLICK') {
        // Only process if forwarded from Background (to avoid duplicate processing)
        if (request.__fromBackground) {
          console.log(
            `[Offscreen] PLUGIN_UI_CLICK received (from Background, passing to plugin-sdk): onclick="${request.onclick}", windowId=${request.windowId}`,
          );
          logger.info(
            `[Offscreen] PLUGIN_UI_CLICK received (from Background, passing to plugin-sdk): onclick="${request.onclick}", windowId=${request.windowId}`,
          );
          // Return false so plugin-sdk's eventEmitter listener can handle it
          return false; // Let plugin-sdk handle it
        } else {
          // Ignore direct messages from Content Script (Background will forward them)
          console.log(
            `[Offscreen] Ignoring PLUGIN_UI_CLICK (direct from Content Script, Background will forward)`,
          );
          logger.debug(
            `[Offscreen] Ignoring PLUGIN_UI_CLICK (direct from Content Script, Background will forward)`,
          );
          return false; // Don't process, let Background forward it
        }
      }

      // Example message handling
      if (request.type === 'PROCESS_DATA') {
        // Process data in offscreen context
        sendResponse({ success: true, data: 'Processed in offscreen' });
        return true;
      }

      // Handle config extraction requests (uses QuickJS)
      if (request.type === 'EXTRACT_CONFIG') {
        logger.debug('Offscreen extracting config from code');

        if (!sessionManager) {
          sendResponse({
            success: false,
            error: 'SessionManager not initialized',
          });
          return true;
        }

        sessionManager
          .awaitInit()
          .then((sm) => sm.extractConfig(request.code))
          .then((config) => {
            logger.debug('Extracted config:', config);
            sendResponse({
              success: true,
              config,
            });
          })
          .catch((error) => {
            logger.error('Config extraction error:', error);
            sendResponse({
              success: false,
              error: error.message,
            });
          });

        return true; // Keep message channel open for async response
      }

      // Handle code execution requests
      if (request.type === 'EXEC_CODE_OFFSCREEN') {
        logger.debug('Offscreen executing code:', request.code);

        if (!sessionManager) {
          sendResponse({
            success: false,
            error: 'SessionManager not initialized',
            requestId: request.requestId,
          });
          return true;
        }

        // Execute plugin code using SessionManager
        sessionManager
          .awaitInit()
          .then((sessionManager) => sessionManager.executePlugin(request.code))
          .then((result) => {
            logger.debug('Plugin execution result:', result);
            sendResponse({
              success: true,
              result,
              requestId: request.requestId,
            });
          })
          .catch((error) => {
            logger.error('Plugin execution error:', error);
            sendResponse({
              success: false,
              error: error.message,
              requestId: request.requestId,
            });
          });

        return true; // Keep message channel open for async response
      }
    });
  }, []);

  return (
    <div className="offscreen-container">
      <h1>Offscreen Document</h1>
      <p>This document runs in the background for processing tasks.</p>
    </div>
  );
};

const container = document.getElementById('app-container');
if (container) {
  const root = createRoot(container);
  root.render(<OffscreenApp />);
}
