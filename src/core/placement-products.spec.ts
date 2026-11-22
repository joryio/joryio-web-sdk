import { toProducts } from './placements';

/** D444 Phase 2b: a recommendation item's product cards, typed defensively. */
describe('placement products (web)', () => {
  it('maps the wire cards and drops entries without an id', () => {
    expect(
      toProducts([
        { id: 'sku-1', title: 'Mug', price: '$9', compareAtPrice: '$10', discountPercent: 10, imageUrl: 'https://cdn/x.png', url: 'https://shop/x' },
        { id: 7, title: 'Numeric id' },
        { title: 'no id' },
        null,
      ]),
    ).toEqual([
      { id: 'sku-1', title: 'Mug', price: '$9', compareAtPrice: '$10', discountPercent: 10, imageUrl: 'https://cdn/x.png', url: 'https://shop/x' },
      { id: '7', title: 'Numeric id', price: null, compareAtPrice: null, discountPercent: null, imageUrl: null, url: null },
    ]);
  });
  it('anything but an array is no products', () => {
    expect(toProducts(undefined)).toEqual([]);
    expect(toProducts({})).toEqual([]);
  });
});
