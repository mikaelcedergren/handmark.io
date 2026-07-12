import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideCxKeyboardFocus } from '@mikaelcedergren/cx-framework';

export const appConfig: ApplicationConfig = {
  providers: [provideCxKeyboardFocus(), provideZoneChangeDetection({ eventCoalescing: true })],
};
