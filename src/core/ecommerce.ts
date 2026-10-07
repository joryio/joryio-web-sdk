/**
 * E-Commerce tracking helpers for Joryio SDK
 */

import type { JoryioSDK } from './sdk';
import { Logger } from '../utils/logger';

export interface EcommerceProduct {
  productId: string;
  name: string;
  price: number;
  quantity?: number;
  category?: string;
  brand?: string;
  variant?: string;
  variantId?: string;
  sku?: string;
  imageUrl?: string;
  url?: string;
}

export interface EcommerceCartItem extends EcommerceProduct {
  quantity: number;
}

export interface EcommerceOrder {
  orderId: string;
  items: EcommerceCartItem[];
  value: number;
  currency?: string;
  shipping?: number;
  tax?: number;
  discount?: number;
  coupon?: string;
}

export interface EcommerceConfig {
  /** Default currency for every event (ISO 4217). Default `USD`. */
  currency?: string;
}

/** A required id or label: a string that is not empty or only whitespace. */
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** A finite number, or undefined - never NaN or Infinity on the wire. */
const finiteOrUndefined = (v: unknown): number | undefined => (isFiniteNumber(v) ? v : undefined);

/**
 * E-Commerce tracking helper class
 * Provides standardized e-commerce event tracking
 *
 * Every helper checks its required arguments and, when one is missing, logs
 * a warning and sends NOTHING (SDK 1.3.0 contract item 42). ONE set on every
 * Joryio SDK and wrapper - web, iOS, Android, React Native, Unity - pinned by
 * the backend's ecommerce-guard-parity spec:
 *  - a product (and every cart/order line): a productId and a finite price;
 *  - cart calls: an items array and a finite cartValue;
 *  - purchase: an orderId, an items array (may be empty) and a finite value;
 *  - every other id or label the event is about (categoryId and
 *    categoryName, query, paymentMethod, shareMethod, orderId, couponCode);
 *  - an optional amount (cartValue on addToCart, shipping, tax, discount,
 *    refundAmount, discountAmount) may be left out, but one given must be
 *    finite - it is refused, not silently dropped.
 * An id that is empty or only whitespace counts as missing. It used to throw into the host page on a missing `items` or a
 * null product, and to send an "Order Completed" with no order id and a total
 * of 0 that reporting counted as a real order. No helper ever throws.
 */
export class EcommerceTracker {
  private sdk: JoryioSDK;
  private config: { currency: string };
  private logger: Logger;

  constructor(sdk: JoryioSDK, config?: EcommerceConfig | null, logger?: Logger) {
    this.sdk = sdk;
    this.config = {
      currency: (config && typeof config.currency === 'string' && config.currency) || 'USD',
    };
    this.logger = logger || new Logger(false);
  }

  /** Run one helper: a missing argument is a warning and no event, never a throw. */
  private guard(method: string, problem: string | null, send: () => void): void {
    if (problem) {
      this.logger.warn(`ecommerce.${method}() not tracked: ${problem}`);
      return;
    }
    try {
      send();
    } catch (error) {
      this.logger.error(`ecommerce.${method}() failed:`, error);
    }
  }

  private productProblem(product: unknown, what = 'product'): string | null {
    if (!product || typeof product !== 'object') return `a ${what} object is required`;
    if (!isText((product as any).productId)) return `${what}.productId is required`;
    if (!isFiniteNumber((product as any).price)) return `${what}.price must be a finite number`;
    return null;
  }

  /** An items array whose every line (a null entry is skipped) is a valid product. */
  private itemsProblem(items: unknown): string | null {
    if (!Array.isArray(items)) return 'an items array is required';
    for (const item of items) {
      if (item == null) continue;
      const problem = this.productProblem(item, 'item');
      if (problem) return problem;
    }
    return null;
  }

  /** A cart: valid lines and a finite total. */
  private cartProblem(items: unknown, cartValue: unknown): string | null {
    return this.itemsProblem(items) ?? (isFiniteNumber(cartValue) ? null : 'cartValue must be a finite number');
  }

  /** Text arguments, each required: the first one missing, or null. */
  private textProblem(args: Record<string, unknown>): string | null {
    for (const [name, value] of Object.entries(args)) {
      if (!isText(value)) return `a ${name} is required`;
    }
    return null;
  }

  /** Optional amounts: absent is fine, present must be finite. */
  private amountsProblem(args: Record<string, unknown>): string | null {
    for (const [name, value] of Object.entries(args)) {
      if (value !== undefined && value !== null && !isFiniteNumber(value)) return `${name} must be a finite number`;
    }
    return null;
  }

  /** The lines to describe (null entries skipped; the rest passed the guard). */
  private validItems(items: EcommerceCartItem[]): EcommerceCartItem[] {
    return items.filter((item) => item && typeof item === 'object');
  }

  private itemCount(items: EcommerceCartItem[]): number {
    return items.reduce((sum, item) => sum + (isFiniteNumber(item.quantity) ? item.quantity : 0), 0);
  }

  /**
   * Track when a user views a product
   */
  viewProduct(product: EcommerceProduct): void {
    this.guard('viewProduct', this.productProblem(product), () => this.sdk.track('Product Viewed', {
      product_id: product.productId,
      name: product.name,
      price: product.price,
      category: product.category,
      brand: product.brand,
      variant: product.variant,
      variant_id: product.variantId,
      sku: product.sku,
      image_url: product.imageUrl,
      url: product.url,
      currency: this.config.currency,
    }));
  }

  /**
   * Track when a user views a category/collection page
   */
  viewCategory(categoryId: string, categoryName: string, properties?: Record<string, any>): void {
    this.guard('viewCategory', this.textProblem({ categoryId, categoryName }), () =>
      this.sdk.track('Product List Viewed', {
        category_id: categoryId,
        category_name: categoryName,
        ...(properties && typeof properties === 'object' ? properties : {}),
      }));
  }

  /**
   * Track when a user searches for products
   */
  search(query: string, resultCount?: number, properties?: Record<string, any>): void {
    this.guard('search', this.textProblem({ query }), () =>
      this.sdk.track('Products Searched', {
        query,
        result_count: finiteOrUndefined(resultCount),
        ...(properties && typeof properties === 'object' ? properties : {}),
      }));
  }

  /**
   * Track when a user adds an item to cart
   */
  addToCart(item: EcommerceCartItem, cartValue?: number): void {
    const problem = this.productProblem(item, 'item') ?? this.amountsProblem({ cartValue });
    this.guard('addToCart', problem, () => this.sdk.track('Product Added', {
      product_id: item.productId,
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      category: item.category,
      brand: item.brand,
      variant: item.variant,
      variant_id: item.variantId,
      sku: item.sku,
      image_url: item.imageUrl,
      url: item.url,
      item_total: finiteOrUndefined(item.price * item.quantity),
      cart_value: finiteOrUndefined(cartValue),
      currency: this.config.currency,
    }));
  }

  /**
   * Track when a user removes an item from cart
   */
  removeFromCart(item: EcommerceProduct, quantity: number = 1): void {
    this.guard('removeFromCart', this.productProblem(item, 'item'), () =>
      this.sdk.track('Product Removed', {
        product_id: item.productId,
        name: item.name,
        price: item.price,
        quantity: isFiniteNumber(quantity) ? quantity : 1,
        variant_id: item.variantId,
        sku: item.sku,
        currency: this.config.currency,
      }));
  }

  /**
   * Track when a user updates their cart
   */
  /**
   * Track the cart being viewed.
   *
   * `Cart Viewed` has been in the canonical event list all along, but no
   * tracker had a method for it - so the one way to send it was to type the
   * name by hand, which is the habit these trackers exist to remove. Same
   * payload as updateCart, since the cart is the same thing either way.
   */
  cartViewed(items: EcommerceCartItem[], cartValue: number): void {
    this.guard('cartViewed', this.cartProblem(items, cartValue), () => {
      const valid = this.validItems(items);
      this.sdk.track('Cart Viewed', {
        items: valid.map((item) => ({
          product_id: item.productId,
          name: item.name,
          price: item.price,
          quantity: item.quantity,
          variant_id: item.variantId,
          sku: item.sku,
        })),
        item_count: this.itemCount(valid),
        cart_value: finiteOrUndefined(cartValue),
        currency: this.config.currency,
      });
    });
  }

  updateCart(items: EcommerceCartItem[], cartValue: number): void {
    this.guard('updateCart', this.cartProblem(items, cartValue), () => {
      const valid = this.validItems(items);
      this.sdk.track('Cart Updated', {
        items: valid.map((item) => ({
          product_id: item.productId,
          name: item.name,
          price: item.price,
          quantity: item.quantity,
          variant_id: item.variantId,
          sku: item.sku,
        })),
        item_count: this.itemCount(valid),
        cart_value: finiteOrUndefined(cartValue),
        currency: this.config.currency,
      });
    });
  }

  /**
   * Track when a user starts checkout
   */
  startCheckout(items: EcommerceCartItem[], cartValue: number, properties?: Record<string, any>): void {
    this.guard('startCheckout', this.cartProblem(items, cartValue), () => {
      const valid = this.validItems(items);
      this.sdk.track('Checkout Started', {
        items: valid.map((item) => ({
          product_id: item.productId,
          name: item.name,
          price: item.price,
          quantity: item.quantity,
          variant_id: item.variantId,
          sku: item.sku,
        })),
        item_count: this.itemCount(valid),
        value: finiteOrUndefined(cartValue),
        currency: this.config.currency,
        ...(properties && typeof properties === 'object' ? properties : {}),
      });
    });
  }

  /**
   * Track when a user adds payment info
   */
  addPaymentInfo(paymentMethod: string, properties?: Record<string, any>): void {
    this.guard('addPaymentInfo', this.textProblem({ paymentMethod }), () =>
      this.sdk.track('Payment Info Entered', {
        payment_method: paymentMethod,
        ...(properties && typeof properties === 'object' ? properties : {}),
      }));
  }

  /**
   * Track when an order is placed
   */
  purchase(order: EcommerceOrder): void {
    // Never a zero or empty order: no order id, no finite value or no items
    // array is a warning and nothing sent (contract item 42).
    const problem = !order || typeof order !== 'object'
      ? 'an order object is required'
      : !isText(order.orderId)
        ? 'order.orderId is required'
        : !isFiniteNumber(order.value)
          ? 'order.value must be a finite number'
          : this.itemsProblem(order.items) ??
            this.amountsProblem({ shipping: order.shipping, tax: order.tax, discount: order.discount });
    this.guard('purchase', problem, () => {
      const items = this.validItems(order.items);
      this.sdk.track('Order Completed', {
        // `orderId` and `total`, NOT `order_id` and `value`.
        //
        // The revenue pipeline reads exactly these two keys - see
        // purchase-vocabulary.ts, which calls `value`/`revenue` "somebody else's
        // convention" and warns that documenting `order_id` "would have told
        // customers to send a key nothing reads". Every purchase tracked through
        // this tracker therefore landed as ZERO revenue with no order id for
        // attribution, on all three SDKs, for as long as it has existed.
        //
        // Not a crash, not a warning: a $0 order that looks like an order.
        orderId: order.orderId,
        items: items.map((item) => ({
          product_id: item.productId,
          name: item.name,
          price: item.price,
          quantity: item.quantity,
          category: item.category,
          brand: item.brand,
          variant_id: item.variantId,
          sku: item.sku,
        })),
        item_count: this.itemCount(items),
        total: order.value,
        currency: order.currency || this.config.currency,
        shipping: finiteOrUndefined(order.shipping),
        tax: finiteOrUndefined(order.tax),
        discount: finiteOrUndefined(order.discount),
        coupon: order.coupon,
      });
    });
  }

  /**
   * Track order fulfillment (shipped)
   */
  orderFulfilled(orderId: string, trackingNumber?: string, carrier?: string): void {
    this.guard('orderFulfilled', isText(orderId) ? null : 'an orderId is required', () =>
      this.sdk.track('Order Fulfilled', {
        order_id: orderId,
        tracking_number: trackingNumber,
        carrier,
      }));
  }

  /**
   * Track order delivery
   */
  orderDelivered(orderId: string): void {
    this.guard('orderDelivered', isText(orderId) ? null : 'an orderId is required', () =>
      this.sdk.track('Order Delivered', {
        order_id: orderId,
      }));
  }

  /**
   * Track order cancellation
   */
  orderCancelled(orderId: string, reason?: string): void {
    this.guard('orderCancelled', isText(orderId) ? null : 'an orderId is required', () =>
      this.sdk.track('Order Cancelled', {
        order_id: orderId,
        reason,
      }));
  }

  /**
   * Track order refund
   */
  orderRefunded(orderId: string, refundAmount?: number, reason?: string): void {
    const problem = this.textProblem({ orderId }) ?? this.amountsProblem({ refundAmount });
    this.guard('orderRefunded', problem, () =>
      this.sdk.track('Order Refunded', {
        order_id: orderId,
        refund_amount: finiteOrUndefined(refundAmount),
        reason,
      }));
  }

  /**
   * Track product added to wishlist
   */
  addToWishlist(product: EcommerceProduct): void {
    this.guard('addToWishlist', this.productProblem(product), () =>
      this.sdk.track('Product Added to Wishlist', {
        product_id: product.productId,
        name: product.name,
        price: product.price,
        category: product.category,
        brand: product.brand,
        currency: this.config.currency,
      }));
  }

  /**
   * Track product removed from wishlist
   */
  removeFromWishlist(product: EcommerceProduct): void {
    this.guard('removeFromWishlist', this.productProblem(product), () =>
      this.sdk.track('Product Removed from Wishlist', {
        product_id: product.productId,
        name: product.name,
      }));
  }

  /**
   * Track product shared
   */
  shareProduct(product: EcommerceProduct, shareMethod: string): void {
    this.guard('shareProduct', this.productProblem(product) ?? this.textProblem({ shareMethod }), () =>
      this.sdk.track('Product Shared', {
        product_id: product.productId,
        name: product.name,
        share_method: shareMethod,
      }));
  }

  /**
   * Track coupon applied
   */
  applyCoupon(couponCode: string, discountAmount?: number, discountType?: 'fixed' | 'percentage'): void {
    const problem = this.textProblem({ couponCode }) ?? this.amountsProblem({ discountAmount });
    this.guard('applyCoupon', problem, () =>
      this.sdk.track('Coupon Applied', {
        coupon_code: couponCode,
        discount_amount: finiteOrUndefined(discountAmount),
        discount_type: discountType,
      }));
  }

  /**
   * Track coupon removed
   */
  removeCoupon(couponCode: string): void {
    this.guard('removeCoupon', isText(couponCode) ? null : 'a couponCode is required', () =>
      this.sdk.track('Coupon Removed', {
        coupon_code: couponCode,
      }));
  }

  /**
   * Track product review submitted
   */
  submitReview(productId: string, rating: number, reviewText?: string): void {
    const problem = !isText(productId) ? 'a productId is required' : !isFiniteNumber(rating) ? 'rating must be a finite number' : null;
    this.guard('submitReview', problem, () =>
      this.sdk.track('Product Reviewed', {
        product_id: productId,
        rating,
        review_text: reviewText,
      }));
  }
}

/**
 * Create an e-commerce tracker instance
 */
export function createEcommerceTracker(sdk: JoryioSDK, config?: EcommerceConfig | null, logger?: Logger): EcommerceTracker {
  return new EcommerceTracker(sdk, config, logger);
}
