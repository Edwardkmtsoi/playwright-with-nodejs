import { chromium, Browser, Page, BrowserContext } from 'playwright';
import fs from 'fs';
import path from 'path';
import logger from '../config/logger';
import env from '../config/env';

/*
 * Directory where per-site storage state (cookies + localStorage) is
 * persisted to disk. This is what lets a store selection (e.g.
 * Supercheap Auto's "SCA Wairau Park") survive between separate
 * n8n-triggered scrape calls, instead of being lost the moment the
 * page/context is closed.
 *
 * IMPORTANT (Railway): the default filesystem is ephemeral and is
 * wiped on redeploy/restart. To persist across redeploys, mount a
 * Railway Volume and point STORAGE_STATE_DIR at it via env var.
 * Without a volume, this still works fine *within* a running
 * container's lifetime across many scrape calls - it just resets
 * on the next deploy.
 */
const STORAGE_STATE_DIR =
  process.env.STORAGE_STATE_DIR ||
  path.join(process.cwd(), 'data', 'storage-state');

export class BrowserService {
  private browser: Browser | null = null;

  /*
   * One BrowserContext per site (e.g. "supercheapauto",
   * "chemistwarehouse", "paknsave"). Keeping sites in separate
   * contexts means each site's cookies/localStorage/store-selection
   * are fully isolated from one another - no risk of one site's
   * session state leaking into or clobbering another's.
   */
  private contexts: Map<string, BrowserContext> = new Map();

  /*
   * Guards against creating two contexts for the same site
   * concurrently if two scrape requests for that site land at
   * nearly the same time.
   */
  private contextCreationLocks: Map<string, Promise<BrowserContext>> =
    new Map();

  private readonly contextOptions = {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    viewport: {
      width: 1366,
      height: 768,
    },
    locale: 'en-NZ',
    timezoneId: 'Pacific/Auckland',
    colorScheme: 'light' as const,
    deviceScaleFactor: 1,
    javaScriptEnabled: true,
    acceptDownloads: false,
    extraHTTPHeaders: {
      'Accept-Language': 'en-NZ,en;q=0.9,en-US;q=0.8',
    },
  };

  /**
   * Launch the shared browser instance. Does NOT create any
   * per-site context - those are created lazily per site the first
   * time createPage(site) is called for that site.
   */
  async initialize(): Promise<void> {
    if (this.browser) return;

    logger.info('Initializing Playwright browser');

    const proxyServer = process.env.PROXY_SERVER;
    const proxyUsername = process.env.PROXY_USERNAME;
    const proxyPassword = process.env.PROXY_PASSWORD;

    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: env.PLAYWRIGHT_HEADLESS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    };

    // Configure proxy only when PROXY_SERVER is provided.
    if (proxyServer) {
      launchOptions.proxy = {
        server: proxyServer,
        ...(proxyUsername
          ? {
              username: proxyUsername,
            }
          : {}),
        ...(proxyPassword
          ? {
              password: proxyPassword,
            }
          : {}),
      };
      logger.info(`Using configured proxy server: ${proxyServer}`);
    } else {
      logger.info('No proxy configured - using direct connection');
    }

    this.browser = await chromium.launch(launchOptions);

    this.ensureStorageStateDirExists();

    logger.info('Playwright browser initialized');
  }

  private ensureStorageStateDirExists(): void {
    try {
      if (!fs.existsSync(STORAGE_STATE_DIR)) {
        fs.mkdirSync(STORAGE_STATE_DIR, { recursive: true });
        logger.info(
          `Created storage state directory: ${STORAGE_STATE_DIR}`
        );
      }
    } catch (error) {
      logger.warn(
        `Failed to create storage state directory ${STORAGE_STATE_DIR}:`,
        error
      );
    }
  }

  private storageStatePath(site: string): string {
    /*
     * Sanitize the site key defensively since it's used to build a
     * filesystem path.
     */
    const safeSite = site.replace(/[^a-z0-9_-]/gi, '_');
    return path.join(STORAGE_STATE_DIR, `${safeSite}.json`);
  }

  /**
   * Get the persistent context for a given site, creating it (and
   * restoring any previously-saved storage state) if it doesn't
   * exist yet.
   */
  private async getOrCreateContext(
    site: string
  ): Promise<BrowserContext> {
    const existing = this.contexts.get(site);

    if (existing) {
      return existing;
    }

    const inFlight = this.contextCreationLocks.get(site);

    if (inFlight) {
      return inFlight;
    }

    const creationPromise = (async (): Promise<BrowserContext> => {
      if (!this.browser) {
        await this.initialize();
      }

      if (!this.browser) {
        throw new Error(
          'Browser failed to initialize'
        );
      }

      const statePath = this.storageStatePath(site);
      const hasStoredState = fs.existsSync(statePath);

      const context = await this.browser.newContext({
        ...this.contextOptions,
        ...(hasStoredState
          ? { storageState: statePath }
          : {}),
      });

      this.contexts.set(site, context);

      logger.info(
        `Created browser context for site="${site}"` +
          `${
            hasStoredState
              ? ' (restored persisted storage state)'
              : ' (fresh, no prior storage state found)'
          }`
      );

      return context;
    })();

    this.contextCreationLocks.set(site, creationPromise);

    try {
      return await creationPromise;
    } finally {
      this.contextCreationLocks.delete(site);
    }
  }

  /**
   * Create a new page within the persistent context for the given
   * site. `site` should be a stable key per store, e.g.
   * "supercheapauto", "chemistwarehouse", "paknsave". Defaults to
   * "default" for backward compatibility if a caller doesn't pass
   * one, but adapters should always pass their own site key.
   */
  async createPage(site: string = 'default'): Promise<Page> {
    const context = await this.getOrCreateContext(site);

    const page = await context.newPage();

    page.setDefaultTimeout(env.PLAYWRIGHT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(env.PLAYWRIGHT_TIMEOUT_MS);

    return page;
  }

  /**
   * Persist the current cookies/localStorage for a site's context
   * to disk. Adapters should call this after a successful store
   * selection (or any other state worth keeping) so future scrapes
   * - including after a container restart, if STORAGE_STATE_DIR is
   * on a persistent volume - can skip re-doing that work.
   */
  async persistStorageState(site: string): Promise<void> {
    const context = this.contexts.get(site);

    if (!context) {
      logger.debug(
        `No active context for site="${site}"; nothing to persist`
      );
      return;
    }

    try {
      this.ensureStorageStateDirExists();

      const statePath = this.storageStatePath(site);

      await context.storageState({ path: statePath });

      logger.debug(
        `Persisted storage state for site="${site}" to ${statePath}`
      );
    } catch (error) {
      logger.warn(
        `Failed to persist storage state for site="${site}":`,
        error
      );
    }
  }

  /**
   * Discard any persisted storage state for a site, forcing the
   * next context creation for that site to start fresh. Useful if
   * a site's store selection ever gets into a bad state.
   */
  async clearStorageState(site: string): Promise<void> {
    try {
      const statePath = this.storageStatePath(site);

      if (fs.existsSync(statePath)) {
        fs.unlinkSync(statePath);
        logger.info(
          `Cleared persisted storage state for site="${site}"`
        );
      }
    } catch (error) {
      logger.warn(
        `Failed to clear storage state for site="${site}":`,
        error
      );
    }
  }

  async closePage(page: Page): Promise<void> {
    try {
      await page.close();
    } catch (error) {
      logger.warn('Error closing page:', error);
    }
  }

  async close(): Promise<void> {
    for (const [site, context] of this.contexts) {
      try {
        await context.close();
      } catch (error) {
        logger.warn(
          `Error closing context for site="${site}":`,
          error
        );
      }
    }

    this.contexts.clear();

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        logger.warn('Error closing browser:', error);
      }
      this.browser = null;
    }

    logger.info('Browser closed');
  }

  isInitialized(): boolean {
    return this.browser !== null;
  }
}

export const browserService = new BrowserService();
