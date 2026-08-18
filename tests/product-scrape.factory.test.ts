import { getProductScraperAdapter } from './scraper-adapter.factory';

describe('scraper adapter factory', () => {
  it('returns Repco adapter', () => {
    const adapter = getProductScraperAdapter('repco');

    expect(adapter.site).toBe('repco');
  });

  it('returns Chemist Warehouse adapter', () => {
    const adapter = getProductScraperAdapter('chemistwarehouse');

    expect(adapter.site).toBe('chemistwarehouse');
  });

  it('throws for unsupported site', () => {
    expect(() =>
      getProductScraperAdapter('bunnings')
    ).toThrow();
  });
});
