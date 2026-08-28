import { isPlatformBrowser } from '@angular/common';
import { ChangeDetectorRef, Component, Inject, PLATFORM_ID } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import {
  CxAlertComponent,
  CxButtonComponent,
  CxCardComponent,
  CxCheckboxComponent,
  CxEmailFieldComponent,
  CxMastheadComponent,
  CxTextFieldComponent,
  CxTextAreaComponent,
  CxValidationMessageComponent,
  type CxFieldValidation,
  type CxMastheadItem,
  type CxValidationMessage,
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
    CxAlertComponent,
    CxButtonComponent,
    CxCardComponent,
    CxCheckboxComponent,
    CxEmailFieldComponent,
    CxMastheadComponent,
    CxTextFieldComponent,
    CxTextAreaComponent,
    CxValidationMessageComponent,
  ],
  templateUrl: './app.component.html',
})
export class AppComponent {
  formStatus = '';
  formState = '';

  readonly mastheadItems: CxMastheadItem[] = [
    { id: 'why', label: 'Why', href: '#why' },
    { id: 'proof', label: 'Proof', href: '#proof' },
    { id: 'standard', label: 'Standard', href: '#standard' },
    { id: 'membership', label: 'Membership', href: '#membership' },
  ];

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

  constructor(
    private readonly changeDetector: ChangeDetectorRef,
    @Inject(DOCUMENT) private readonly document: Document,
    @Inject(PLATFORM_ID) platformId: object,
  ) {
    this.isBrowser = isPlatformBrowser(platformId);
  }

  get agreementValidationMessages(): readonly CxValidationMessage[] {
    return this.agreeError ? [{ type: 'error', message: this.agreeError }] : [];
  }

  scrollTo(id: string): void {
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
    if (this.formState === 'pending') return;

    if (!this.validate()) {
      this.formStatus = '';
      this.formState = '';
      this.focusFirstInvalidField();
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
        signal: AbortSignal.timeout(15_000),
      });
      const result = (await response.json().catch(() => null)) as {
        error?: { message?: string };
        id?: string;
        ok?: boolean;
      } | null;

      if (!response.ok || !result?.ok || !result.id) {
        throw new Error(result?.error?.message || 'Application could not be saved.');
      }

      this.resetModel();
      this.formStatus = `Application ${result.id} received. We will contact you for the process walkthrough.`;
      this.formState = 'success';
    } catch (error) {
      this.formStatus =
        error instanceof DOMException && error.name === 'TimeoutError'
          ? 'The application took too long to save. Please try again.'
          : error instanceof Error
            ? error.message
            : 'Application could not be saved.';
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

  private focusFirstInvalidField(): void {
    if (!this.isBrowser) return;

    this.changeDetector.detectChanges();
    const form = this.document.getElementById('application-form');
    const invalidField = form?.querySelector<HTMLElement>(
      'input[aria-invalid="true"], textarea[aria-invalid="true"]',
    );
    const agreement = !this.model.agree
      ? form?.querySelector<HTMLElement>('input[type="checkbox"]')
      : null;
    (invalidField ?? agreement)?.focus();
  }
}
