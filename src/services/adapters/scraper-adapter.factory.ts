import { BadRequestError } from '../../utils/http-error';
import { SupportedScrapeSite } from '../../types/product-scrape.types';
import { ProductScraperAdapter } from './scraper-adapter.interface';
import { repcoAdapter } from './repco.adapter';
import { chemistWarehouseAdapter } from './chemistwarehouse.adapter';
import { supercheapAutoAdapter } from './supercheapauto.adapter';
import { woolworthsAdapter } from './woolworthsAdapter';
import { hyperdriveAdapter } from './hyperdrive.adapter';
import { newWorldAdapter } from './new-world.adapter';

const siteAliases: Record<string, SupportedScrapeSite> = {
  repco: 'repco',

  chemistwarehouse: 'chemistwarehouse',
  'chemist-warehouse': 'chemistwarehouse',
  chemist: 'chemistwarehouse',
  cw: 'chemistwarehouse',

  supercheapauto: 'supercheapauto',
  'supercheap-auto': 'supercheapauto',
  supercheap: 'supercheapauto',
  sca: 'supercheapauto',

  woolworths: 'woolworths',
  woolworth: 'woolworths',
  countdown: 'woolworths',

  hyperdrive: 'hyperdrive',
  hyperdrives: 'hyperdrive',
  
  newworld: 'newwworld',
  newworld: 'newwworld',
  
};

const adapters: Record<
  SupportedScrapeSite,
  ProductScraperAdapter
> = {
  repco: repcoAdapter,
  chemistwarehouse: chemistWarehouseAdapter,
  supercheapauto: supercheapAutoAdapter,
  woolworths: woolworthsAdapter,
  hyperdrive: hyperdriveAdapter,
  newworld: newWorldAdapter,

};

function normalizeSite(site: string): SupportedScrapeSite | null {
  const normalized = site.trim().toLowerCase().replace(/\s+/g, '');

  return siteAliases[normalized] || null;
}

export function getProductScraperAdapter(
  site: string
): ProductScraperAdapter {
  const normalizedSite = normalizeSite(site);

  if (!normalizedSite) {
    throw new BadRequestError(`Unsupported scrape site: ${site}`);
  }

  const adapter = adapters[normalizedSite];

  if (!adapter) {
    throw new BadRequestError(`Unsupported scrape site: ${site}`);
  }

  return adapter;
}

export function getSupportedScrapeSites(): SupportedScrapeSite[] {
  return Object.keys(adapters) as SupportedScrapeSite[];
}
