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

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

/*
 * Sites that need HTTP/2 disabled at the Chromium launch level.
 * This is a launch-wide flag (Playwright can't toggle it per
 * context), so rather than applying it globally - which forces
 * every site onto HTTP/1.1, an unusual signal for a real browser -
 * it's opt-in per site here. Add a site key to this set only if
 * that specific site throws net::ERR_HTTP2_PROTOCOL_ERROR.
 *
 * NOTE: because this is launch-wide, if ANY site in this set is
 * used, --disable-http2 applies to ALL contexts, including sites
 * not in the set. Keep this set empty unless something genuinely
 * needs it.
 */
const SITES_REQUIRING_HTTP1: Set<string> = new Set([
  // 'woolworths', // re-add if Woolworths starts failing again
]);

export class BrowserService {
  private browser: Browser | null = null;

  /*
   * One BrowserContext per site (e.g. "supercheapauto",
   * "chemistwarehouse", "woolworths", "newworld"). Keeping sites in
   * separate contexts means each site's cookies/localStorage/store-
   * selection are fully isolated from one another - no risk of one
   * site's session state leaking into or clobbering another's.
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
   * Default proxy (used for every site's context unless that site
   * has its own override - see getProxyConfigForSite()). Read once
   * at launch time from PROXY_SERVER / PROXY_USERNAME / PROXY_PASSWORD.
   */
  private defaultProxy: ProxyConfig | null = null;

  /**
   * Launch the shared browser instance. Does NOT create any
   * per-site context - those are created lazily per site the first
   * time createPage(site) is called for that site.
   *
   * NOTE: the browser itself is launched WITHOUT a proxy baked in.
   * Proxies are applied per-context instead (see
   * getProxyConfigForSite() / getOrCreateContext()), because
   * Playwright allows each newContext() call to specify its own
   * proxy, overriding whatever (if anything) was set at launch.
   * This lets different sites use different proxies - e.g.
   * Woolworths on a dedicated mobile proxy, everything else on the
   * shared residential/static one - without running multiple
   * browser processes.
   */
  async initialize(): Promise<void> {
    if (this.browser) return;

    logger.info('Initializing Playwright browser');

    const proxyServer = process.env.PROXY_SERVER;
    const proxyUsername = process.env.PROXY_USERNAME;
    const proxyPassword = process.env.PROXY_PASSWORD;

    if (proxyServer) {
      this.defaultProxy = {
        server: proxyServer,
        ...(proxyUsername ? { username: proxyUsername } : {}),
        ...(proxyPassword ? { password: proxyPassword } : {}),
      };
      logger.info(
        `Default proxy configured: ${proxyServer} (applied per-context)`
      );
    } else {
      logger.info(
        'No default proxy configured - contexts without a ' +
          'site-specific proxy will use a direct connection'
      );
    }

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      /*
       * Reduces some (not all) automation tells. Real Chrome ships
       * with this feature enabled; some bot-detection scripts check
       * for its absence as a signal.
       */
      '--disable-blink-features=AutomationControlled',
    ];

    if (SITES_REQUIRING_HTTP1.size > 0) {
      /*
       * Force HTTP/1.1 instead of HTTP/2. This is launch-wide - see
       * SITES_REQUIRING_HTTP1 above for why it's opt-in and the
       * tradeoff of enabling it.
       */
      launchArgs.push('--disable-http2');
      logger.info(
        `HTTP/1.1 forced at launch because these sites require it: ` +
          `${Array.from(SITES_REQUIRING_HTTP1).join(', ')}`
      );
    }

    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: env.PLAYWRIGHT_HEADLESS,
      args: launchArgs,
      /*
       * Use real installed Chrome instead of Playwright's bundled
       * Chromium when available. Real Chrome's build matches what
       * bot-detection services expect much more closely (bundled
       * Chromium has subtle differences in version strings, some
       * headless-specific behaviors, etc). Falls back to bundled
       * Chromium automatically if the "chrome" channel isn't
       * installed in this environment - set PLAYWRIGHT_CHANNEL=""
       * to explicitly disable this and always use bundled Chromium.
       */
      ...(env.PLAYWRIGHT_CHANNEL
        ? { channel: env.PLAYWRIGHT_CHANNEL }
        : {}),
    };

    try {
      this.browser = await chromium.launch(launchOptions);
    } catch (error) {
      if (env.PLAYWRIGHT_CHANNEL) {
        logger.warn(
          `Failed to launch with channel="${env.PLAYWRIGHT_CHANNEL}" ` +
            `(likely not installed in this environment); falling back ` +
            `to bundled Chromium`,
          error
        );

        this.browser = await chromium.launch({
          ...launchOptions,
          channel: undefined,
        });
      } else {
        throw error;
      }
    }

    this.ensureStorageStateDirExists();

    logger.info('Playwright browser initialized');
  }

  /**
   * Resolve which proxy a given site's context should use.
   *
   * Looks for site-specific env vars first, following the pattern:
   *
   *   PROXY_SERVER_<SITE>
   *   PROXY_USERNAME_<SITE>
   *   PROXY_PASSWORD_<SITE>
   *
   * e.g. for site="woolworths":
   *
   *   PROXY_SERVER_WOOLWORTHS
   *   PROXY_USERNAME_WOOLWORTHS
   *   PROXY_PASSWORD_WOOLWORTHS
   *
   * Falls back to the default proxy (PROXY_SERVER / etc.) if no
   * site-specific override is set. Returns null if neither is
   * configured (direct connection).
   */
  private getProxyConfigForSite(site: string): ProxyConfig | null {
    const siteKey = site.toUpperCase().replace(/[^A-Z0-9]/g, '_');

    const siteServer = process.env[`PROXY_SERVER_${siteKey}`];

    if (siteServer) {
      const siteUsername =
        process.env[`PROXY_USERNAME_${siteKey}`];
      const sitePassword =
        process.env[`PROXY_PASSWORD_${siteKey}`];

      logger.info(
        `Using site-specific proxy for site="${site}": ${siteServer}`
      );

      return {
        server: siteServer,
        ...(siteUsername ? { username: siteUsername } : {}),
        ...(sitePassword ? { password: sitePassword } : {}),
      };
    }

    return this.defaultProxy;
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
   * Applies stealth patches to a context to reduce common headless
   * automation tells that bot-management services (e.g. Cloudflare)
   * check for via JS. This is not a guarantee of evasion - just
   * removes the most basic, well-known signals.
   */
  private async applyStealthPatches(
    context: BrowserContext
  ): Promise<void> {
    await context.addInitScript(() => {
      // Remove the automation flag real browsers never set.
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });

      // Headless Chromium reports an empty plugins array; real
      // Chrome always has a handful (PDF viewer, etc).
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // Real Chrome exposes navigator.languages as a populated array.
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-NZ', 'en'],
      });

      // window.chrome is absent in some headless configurations;
      // real Chrome always defines it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).chrome = { runtime: {} };

      // Patch the permissions API - headless Chromium sometimes
      // resolves navigator.permissions.query() differently than a
      // real user profile would for notifications.
      const originalQuery = window.navigator.permissions.query;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.navigator.permissions.query as any) = (
        parameters: PermissionDescriptor
      ) =>
        parameters.name === 'notifications'
          ? Promise.resolve({
              state: Notification.permission,
            } as PermissionStatus)
          : originalQuery(parameters);
    });
  }

  /**
   * Get the persistent context for a given site, creating it (and
   * restoring any previously-saved storage state) if it doesn't
   * exist yet. Applies that site's resolved proxy config, if any,
   * plus stealth patches.
   *
   * @param proxyOverride - if provided (including explicit `null`),
   * takes precedence over the site's own env-var-resolved proxy.
   * Useful when a site should borrow another site's proxy
   * credentials instead of using its own PROXY_SERVER_<SITE> vars.
   */
  private async getOrCreateContext(
    site: string,
    proxyOverride?: ProxyConfig | null
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

      const proxy =
        proxyOverride !== undefined
          ? proxyOverride
          : this.getProxyConfigForSite(site);

      const context = await this.browser.newContext({
        ...this.contextOptions,
        ...(hasStoredState ? { storageState: statePath } : {}),
        ...(proxy ? { proxy } : {}),
      });

      await this.applyStealthPatches(context);

      this.contexts.set(site, context);

      logger.info(
        `Created browser context for site="${site}"` +
          `${
            hasStoredState
              ? ' (restored persisted storage state)'
              : ' (fresh, no prior storage state found)'
          }` +
          `${proxy ? ` (proxy: ${proxy.server})` : ' (no proxy)'}`
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
   * "supercheapauto", "chemistwarehouse", "woolworths", "newworld".
   * Defaults to "default" for backward compatibility if a caller
   * doesn't pass one, but adapters should always pass their own
   * site key.
   *
   * @param proxyOverride - optional explicit proxy config, taking
   * precedence over the site's own PROXY_SERVER_<SITE> env vars.
   */
  async createPage(
    site: string = 'default',
    proxyOverride?: ProxyConfig | null
  ): Promise<Page> {
    const context = await this.getOrCreateContext(site, proxyOverride);

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
   * on a persistent volume - can skip re-doing that work. For sites
   * behind a JS bot-challenge (e.g. Cloudflare), this also captures
   * the cf_clearance cookie once a challenge is passed, letting
   * subsequent scrapes potentially skip the challenge entirely -
   * as long as the same proxy/IP is used on the next request too.
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
