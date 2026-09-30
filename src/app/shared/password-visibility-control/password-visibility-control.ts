import {
  AfterViewInit,
  Component,
  computed,
  ElementRef,
  input,
  OnDestroy,
  signal,
} from '@angular/core';

@Component({
  selector: 'app-password-visibility-control',
  standalone: true,
  template: `
    <ng-content select="input" />
    <button
      type="button"
      [attr.aria-controls]="controlledInputId()"
      [attr.aria-label]="accessibleLabel()"
      [attr.aria-pressed]="revealed()"
      [disabled]="inputDisabled()"
      [title]="accessibleLabel()"
      (click)="toggle()"
    >
      {{ revealed() ? 'Hide' : 'Show' }}
    </button>
  `,
  styleUrl: './password-visibility-control.css',
})
export class PasswordVisibilityControl implements AfterViewInit, OnDestroy {
  readonly passwordName = input('password');
  readonly revealed = signal(false);
  readonly controlledInputId = signal<string | null>(null);
  readonly inputDisabled = signal(true);
  readonly accessibleLabel = computed(
    () => `${this.revealed() ? 'Hide' : 'Show'} ${this.passwordName()}`,
  );

  private passwordInput: HTMLInputElement | null = null;
  private disabledObserver: MutationObserver | null = null;

  constructor(private readonly host: ElementRef<HTMLElement>) {}

  ngAfterViewInit(): void {
    this.passwordInput = this.host.nativeElement.querySelector('input');
    this.controlledInputId.set(this.passwordInput?.id || null);
    this.syncDisabledState();

    if (this.passwordInput && typeof MutationObserver !== 'undefined') {
      this.disabledObserver = new MutationObserver(() => this.syncDisabledState());
      this.disabledObserver.observe(this.passwordInput, {
        attributes: true,
        attributeFilter: ['disabled'],
      });
    }
  }

  ngOnDestroy(): void {
    this.disabledObserver?.disconnect();

    if (this.passwordInput) {
      this.passwordInput.type = 'password';
    }
  }

  toggle(): void {
    if (!this.passwordInput || this.passwordInput.disabled) {
      return;
    }

    const nextRevealed = !this.revealed();
    this.passwordInput.type = nextRevealed ? 'text' : 'password';
    this.revealed.set(nextRevealed);
  }

  private syncDisabledState(): void {
    const disabled = !this.passwordInput || this.passwordInput.disabled;
    this.inputDisabled.set(disabled);

    if (disabled && this.passwordInput && this.revealed()) {
      this.passwordInput.type = 'password';
      this.revealed.set(false);
    }
  }
}
