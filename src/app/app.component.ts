import { isPlatformBrowser } from '@angular/common';
import { AfterViewInit, Component, ElementRef, HostListener, Inject, OnDestroy, PLATFORM_ID } from '@angular/core';
import { DOCUMENT } from '@angular/common';

@Component({
  selector: 'app-root',
  standalone: true,
  templateUrl: './app.component.html',
})
export class AppComponent implements AfterViewInit, OnDestroy {
  navOpen = false;
  formStatus = '';
  formState = '';
  private readonly isBrowser: boolean;
  private mediaQuery?: MediaQueryList;
  private readonly mediaListener = (event: MediaQueryListEvent) => {
    if (event.matches) this.closeMenu();
  };

  constructor(
    private readonly elementRef: ElementRef<HTMLElement>,
    @Inject(DOCUMENT) private readonly document: Document,
    @Inject(PLATFORM_ID) platformId: object,
  ) {
    this.isBrowser = isPlatformBrowser(platformId);
  }

  ngAfterViewInit(): void {
    if (!this.isBrowser) return;
    this.mediaQuery = window.matchMedia('(min-width: 981px)');
    this.mediaQuery.addEventListener('change', this.mediaListener);
  }

  ngOnDestroy(): void {
    this.mediaQuery?.removeEventListener('change', this.mediaListener);
    this.document.body.classList.remove('nav-open');
  }

  toggleMenu(): void {
    this.setMenuOpen(!this.navOpen);
  }

  closeMenu(): void {
    this.setMenuOpen(false);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeMenu();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.navOpen) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    const host = this.elementRef.nativeElement;
    const navPanel = host.querySelector('#primary-menu');
    const menuToggle = host.querySelector('.menu-toggle');
    if (!navPanel?.contains(target) && !menuToggle?.contains(target)) this.closeMenu();
  }

  resetApplication(event: Event): void {
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    window.setTimeout(() => {
      const selectedPlan = form.querySelector<HTMLInputElement>('input[name="plan"]');
      if (selectedPlan) selectedPlan.value = 'verification';
    });
  }

  async submitApplication(event: Event): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;

    this.formStatus = 'Saving application...';
    this.formState = 'pending';

    const formData = new FormData(form);
    const payload: Record<string, FormDataEntryValue | boolean> = Object.fromEntries(formData.entries());
    payload['agree'] = formData.has('agree');
    payload['brand'] = payload['brand'] || payload['name'] || '';
    payload['category'] = payload['category'] || 'Human-made work';
    payload['billingCycle'] = payload['billingCycle'] || 'monthly';
    payload['paymentPreference'] = payload['paymentPreference'] || 'after-approval';

    try {
      const response = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();

      if (!response.ok || !result.ok) {
        throw new Error(result.message || 'Application could not be saved.');
      }

      form.reset();
      const selectedPlan = form.querySelector<HTMLInputElement>('input[name="plan"]');
      if (selectedPlan) selectedPlan.value = 'verification';
      this.formStatus = `Application ${result.id} received. We will contact you for the process walkthrough.`;
      this.formState = 'success';
    } catch (error) {
      this.formStatus = error instanceof Error ? error.message : 'Application could not be saved.';
      this.formState = 'error';
    }
  }

  private setMenuOpen(isOpen: boolean): void {
    this.navOpen = isOpen;
    this.document.body.classList.toggle('nav-open', isOpen);
  }
}
