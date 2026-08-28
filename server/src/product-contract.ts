import type { ProductManifest } from '@mikaelcedergren/cx-framework/server/product-manifest';

import { HANDMARK_PRODUCT_ID } from './constants.js';

export function assertHandmarkProductManifest(manifest: ProductManifest): void {
  const valid =
    manifest.id === HANDMARK_PRODUCT_ID &&
    manifest.family === 'web' &&
    manifest.profile === 'hybrid-site' &&
    manifest.deployment === 'mac-mini' &&
    manifest.frontend.framework === 'angular' &&
    manifest.frontend.rendering === 'ssg' &&
    manifest.frontend.designSystem === 'cx-framework' &&
    manifest.frontend.visualSystem === 'framework' &&
    manifest.capabilities.authentication === 'gate' &&
    manifest.capabilities.persistentData === 'structured-records' &&
    manifest.capabilities.backgroundWork === 'none' &&
    manifest.capabilities.externalEffects.length === 0;

  if (!valid) {
    throw new Error('Handmark runtime capabilities do not match cx-product.json.');
  }
}
