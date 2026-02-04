import Host, { Parser } from '@tlsn/plugin-sdk/src';
import { ProveManager } from './ProveManager';
import type { Method } from '../../../tlsn-wasm-pkg/tlsn_wasm';
import { DomJson, Handler, PluginConfig } from '@tlsn/plugin-sdk/src/types';
import { processHandlers } from './rangeExtractor';
import { logger } from '@tlsn/common';
import {
  validateProvePermission,
  validateOpenWindowPermission,
} from './permissionValidator';

export class SessionManager {
  private host: Host;
  private proveManager: ProveManager;
  private initPromise: Promise<void>;
  private currentConfig: PluginConfig | null = null;

  constructor() {
    this.host = new Host({
      onProve: async (
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
          sessionData?: Record<string, string>;
        },
      ) => {
        console.log('[SessionManager] onProve called:', {
          url: requestOptions.url,
          method: requestOptions.method,
          verifierUrl: proverOptions.verifierUrl,
        });
        logger.info('[SessionManager] onProve called:', {
          url: requestOptions.url,
          method: requestOptions.method,
          verifierUrl: proverOptions.verifierUrl,
        });

        let url;

        try {
          url = new URL(requestOptions.url);
          console.log('[SessionManager] URL parsed:', url.hostname);
        } catch (error) {
          console.error('[SessionManager] Invalid URL:', error);
          throw new Error('Invalid URL');
        }

        // Validate permissions before proceeding
        console.log('[SessionManager] Validating permissions...');
        try {
          validateProvePermission(
            requestOptions,
            proverOptions,
            this.currentConfig,
          );
          console.log('[SessionManager] Permissions validated');
        } catch (error) {
          console.error('[SessionManager] Permission validation failed:', error);
          throw error;
        }

        // Build sessionData with defaults + user-provided data
        const sessionData: Record<string, string> = {
          ...proverOptions.sessionData,
        };

        console.log('[SessionManager] Creating prover...', {
          hostname: url.hostname,
          verifierUrl: proverOptions.verifierUrl,
        });
        logger.info('[SessionManager] Creating prover:', {
          hostname: url.hostname,
          verifierUrl: proverOptions.verifierUrl,
        });

        const proverId = await this.proveManager.createProver(
          url.hostname,
          proverOptions.verifierUrl,
          proverOptions.maxRecvData,
          proverOptions.maxSentData,
          sessionData,
        );
        console.log('[SessionManager] Prover created:', proverId);

        const prover = await this.proveManager.getProver(proverId);

        const headerMap: Map<string, number[]> = new Map();
        Object.entries(requestOptions.headers).forEach(([key, value]) => {
          headerMap.set(key, Buffer.from(value).toJSON().data);
        });

        await prover.send_request(proverOptions.proxyUrl, {
          uri: requestOptions.url,
          method: requestOptions.method as Method,
          headers: headerMap,
          body: requestOptions.body,
        });

        // Get transcripts for parsing
        const { sent, recv } = await prover.transcript();

        const parsedSent = new Parser(Buffer.from(sent));
        const parsedRecv = new Parser(Buffer.from(recv));

        logger.debug('parsedSent', parsedSent.json());
        logger.debug('parsedRecv', parsedRecv.json());

        // Use refactored range extraction logic
        const {
          sentRanges,
          recvRanges,
          sentRangesWithHandlers,
          recvRangesWithHandlers,
        } = processHandlers(proverOptions.handlers, parsedSent, parsedRecv);

        logger.debug('sentRanges', sentRanges);
        logger.debug('recvRanges', recvRanges);

        // Send reveal config (ranges + handlers) to verifier BEFORE calling reveal()
        await this.proveManager.sendRevealConfig(proverId, {
          sent: sentRangesWithHandlers,
          recv: recvRangesWithHandlers,
        });

        // Reveal the ranges
        await prover.reveal({
          sent: sentRanges,
          recv: recvRanges,
          server_identity: true,
        });

        // Get structured response from verifier (now includes handler results)
        const response = await this.proveManager.getResponse(proverId);

        return response;
      },
      onRenderPluginUi: (windowId: number, result: DomJson) => {
        const chromeRuntime = (
          global as unknown as { chrome?: { runtime?: any } }
        ).chrome?.runtime;
        if (!chromeRuntime?.sendMessage) {
          throw new Error('Chrome runtime not available');
        }
        chromeRuntime.sendMessage({
          type: 'RENDER_PLUGIN_UI',
          json: result,
          windowId: windowId,
        });
      },
      onCloseWindow: (windowId: number) => {
        const chromeRuntime = (
          global as unknown as { chrome?: { runtime?: any } }
        ).chrome?.runtime;
        if (!chromeRuntime?.sendMessage) {
          throw new Error('Chrome runtime not available');
        }
        logger.debug('onCloseWindow', windowId);
        return chromeRuntime.sendMessage({
          type: 'CLOSE_WINDOW',
          windowId,
        });
      },
      onOpenWindow: async (
        url: string,
        options?: { width?: number; height?: number; showOverlay?: boolean },
      ) => {
        // Validate permissions before proceeding
        validateOpenWindowPermission(url, this.currentConfig);

        const chromeRuntime = (
          global as unknown as { chrome?: { runtime?: any } }
        ).chrome?.runtime;
        if (!chromeRuntime?.sendMessage) {
          throw new Error('Chrome runtime not available');
        }
        return chromeRuntime.sendMessage({
          type: 'OPEN_WINDOW',
          url,
          width: options?.width,
          height: options?.height,
          showOverlay: options?.showOverlay,
        });
      },
    });
    this.proveManager = new ProveManager();
    this.initPromise = new Promise(async (resolve) => {
      await this.proveManager.init();
      resolve();
    });
  }

  async awaitInit(): Promise<SessionManager> {
    await this.initPromise;
    return this;
  }

  async executePlugin(code: string): Promise<unknown> {
    const chromeRuntime = (global as unknown as { chrome?: { runtime?: any } })
      .chrome?.runtime;
    if (!chromeRuntime?.onMessage) {
      throw new Error('Chrome runtime not available');
    }

    logger.info('[SessionManager] Starting plugin execution...');
    console.log('[SessionManager] Starting plugin execution...');

    // Extract and store plugin config before execution for permission validation
    this.currentConfig = await this.extractConfig(code);
    logger.debug(
      '[SessionManager] Extracted plugin config:',
      this.currentConfig,
    );

    logger.info(
      '[SessionManager] Creating eventEmitter for plugin-sdk...',
    );
    console.log('[SessionManager] Creating eventEmitter for plugin-sdk...');

    return this.host.executePlugin(code, {
      eventEmitter: {
        addListener: (listener: (message: any) => void) => {
          console.log(
            '[SessionManager] eventEmitter.addListener called, registering listener for plugin-sdk',
          );
          logger.debug(
            '[SessionManager] Registering eventEmitter listener',
          );
          chromeRuntime.onMessage.addListener(listener);
        },
        removeListener: (listener: (message: any) => void) => {
          console.log('[SessionManager] eventEmitter.removeListener called');
          chromeRuntime.onMessage.removeListener(listener);
        },
        emit: (message: any) => {
          console.log('[SessionManager] eventEmitter.emit:', message);
          chromeRuntime.sendMessage(message);
        },
      },
    });
  }

  /**
   * Extract plugin config using QuickJS sandbox (more reliable than regex)
   */
  async extractConfig(code: string): Promise<any> {
    return this.host.getPluginConfig(code);
  }
}
