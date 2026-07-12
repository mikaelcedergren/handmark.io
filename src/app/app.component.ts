import { isPlatformBrowser } from '@angular/common';
import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, Inject, OnDestroy, PLATFORM_ID } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import {
  CxButtonComponent,
  CxCheckboxComponent,
  CxEmailFieldComponent,
  CxIconButtonComponent,
  CxTextFieldComponent,
  CxTextareaComponent,
  type CxFieldValidation,
} from '@mikaelcedergren/cx-framework';

interface ApplicationModel {
  name: string;
  email: string;
  contactPreference: string;
  brand: string;
  category: string;
  website: string;
  craftSummary: string;
  proofLinks: string;
  walkthroughPreference: string;
  agree: boolean;
}

type ApplicationField = keyof ApplicationModel;

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CxButtonComponent,
    CxCheckboxComponent,
    CxEmailFieldComponent,
    CxIconButtonComponent,
    CxTextFieldComponent,
    CxTextareaComponent,
  ],
  templateUrl: './app.component.html',
})
export class AppComponent implements AfterViewInit, OnDestroy {
  navOpen = false;
  formStatus = '';
  formState = '';

  readonly model: ApplicationModel = {
    name: '',
    email: '',
    contactPreference: '',
    brand: '',
    category: '',
    website: '',
    craftSummary: '',
    proofLinks: '',
    walkthroughPreference: '',
    agree: false,
  };

  readonly errors: Partial<Record<ApplicationField, CxFieldValidation>> = {};
  agreeError = '';

  private readonly isBrowser: boolean;
  private mediaQuery?: MediaQueryList;
  private readonly mediaListener = (event: MediaQueryListEvent) => {
    if (event.matches) this.closeMenu();
  };

  constructor(
    private readonly elementRef: ElementRef<HTMLElement>,
    private readonly changeDetector: ChangeDetectorRef,
    @Inject(DOCUMENT) private readonly document: Document,
    @Inject(PLATFORM_ID) platformId: object,
  ) {
    this.isBrowser = isPlatformBrowser(platformId);
  }

  ngAfterViewInit(): void {
    if (!this.isBrowser) return;
    // Matches the framework mobile breakpoint so the drawer closes exactly when
    // the layout returns to the desktop header.
    this.mediaQuery = window.matchMedia('(min-width: 720px)');
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

  scrollTo(id: string): void {
    this.closeMenu();
    if (!this.isBrowser) return;
    this.document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  setField(field: ApplicationField, value: string): void {
    (this.model[field] as string) = value;
    if (this.errors[field]) delete this.errors[field];
  }

  setAgree(selected: boolean): void {
    this.model.agree = selected;
    if (selected) this.agreeError = '';
  }

  async submitApplication(): Promise<void> {
    if (!this.validate()) {
      this.formStatus = 'Fix the highlighted fields and try again.';
      this.formState = 'error';
      return;
    }

    this.formStatus = 'Saving application...';
    this.formState = 'pending';

    const payload = {
      plan: 'verification',
      billingCycle: 'monthly',
      paymentPreference: 'after-approval',
      name: this.model.name.trim(),
      email: this.model.email.trim(),
      contactPreference: this.model.contactPreference.trim(),
      brand: (this.model.brand || this.model.name).trim(),
      category: (this.model.category || 'Human-made work').trim(),
      website: this.model.website.trim(),
      craftSummary: this.model.craftSummary.trim(),
      proofLinks: this.model.proofLinks.trim(),
      walkthroughPreference: this.model.walkthroughPreference.trim(),
      agree: this.model.agree,
    };

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

      this.resetModel();
      this.formStatus = `Application ${result.id} received. We will contact you for the process walkthrough.`;
      this.formState = 'success';
    } catch (error) {
      this.formStatus = error instanceof Error ? error.message : 'Application could not be saved.';
      this.formState = 'error';
    } finally {
      // The status update lands after an await, so flush it explicitly rather
      // than relying on a change-detection tick being scheduled for us.
      this.changeDetector.detectChanges();
    }
  }

  private validate(): boolean {
    for (const key of Object.keys(this.errors) as ApplicationField[]) delete this.errors[key];
    this.agreeError = '';

    const required: ReadonlyArray<[ApplicationField, string]> = [
      ['name', 'Enter your name or studio.'],
      ['email', 'Enter your email address.'],
      ['contactPreference', 'Tell us the best way to reach you.'],
      ['brand', 'Enter the brand or work name.'],
      ['category', 'Enter the kind of work you make.'],
      ['website', 'Add a website or public profile.'],
      ['craftSummary', 'Describe what you make.'],
      ['proofLinks', 'Share proof links we can review.'],
    ];

    for (const [field, message] of required) {
      if (!this.model[field].toString().trim()) this.errors[field] = message;
    }

    if (this.model.email.trim() && !EMAIL_PATTERN.test(this.model.email.trim())) {
      this.errors.email = 'Enter a valid email address.';
    }

    if (!this.model.agree) {
      this.agreeError = 'Confirm the review terms to continue.';
    }

    return Object.keys(this.errors).length === 0 && !this.agreeError;
  }

  private resetModel(): void {
    (Object.keys(this.model) as ApplicationField[]).forEach((key) => {
      if (key === 'agree') {
        this.model.agree = false;
      } else {
        (this.model[key] as string) = '';
      }
    });
  }

  private setMenuOpen(isOpen: boolean): void {
    this.navOpen = isOpen;
    this.document.body.classList.toggle('nav-open', isOpen);
  }
}
