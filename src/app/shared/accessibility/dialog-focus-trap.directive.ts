import {
  AfterViewInit,
  Directive,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnDestroy,
  Output,
  Renderer2,
} from '@angular/core';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

@Directive({
  selector: '[appDialogFocusTrap]',
  standalone: true,
})
export class DialogFocusTrapDirective implements AfterViewInit, OnDestroy {
  @Input() dialogInitialFocus = '';
  @Input() dialogCloseOnEscape = true;
  @Output() readonly dialogEscape = new EventEmitter<void>();

  private readonly host: HTMLElement;
  private readonly restoreTarget: HTMLElement | null;
  private focusFrame: number | null = null;

  constructor(
    elementRef: ElementRef<HTMLElement>,
    renderer: Renderer2,
  ) {
    this.host = elementRef.nativeElement;
    this.restoreTarget =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    if (!this.host.hasAttribute('tabindex')) {
      renderer.setAttribute(this.host, 'tabindex', '-1');
    }
  }

  ngAfterViewInit(): void {
    this.scheduleInitialFocus();
  }

  ngOnDestroy(): void {
    if (this.focusFrame !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(this.focusFrame);
    }

    if (
      this.restoreTarget &&
      this.restoreTarget.isConnected &&
      !this.restoreTarget.hasAttribute('disabled')
    ) {
      window.requestAnimationFrame(() => {
        this.restoreTarget?.focus({ preventScroll: true });
      });
    }
  }

  @HostListener('keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (!this.dialogCloseOnEscape) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      this.dialogEscape.emit();
      return;
    }

    if (event.key !== 'Tab') {
      return;
    }

    const focusable = this.getFocusableElements();

    if (focusable.length === 0) {
      event.preventDefault();
      this.host.focus({ preventScroll: true });
      return;
    }

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const activeElement = document.activeElement;

    if (event.shiftKey && (activeElement === first || activeElement === this.host)) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private scheduleInitialFocus(): void {
    if (typeof window === 'undefined') {
      return;
    }

    this.focusFrame = window.requestAnimationFrame(() => {
      this.focusFrame = null;

      const preferred = this.dialogInitialFocus
        ? this.host.querySelector<HTMLElement>(this.dialogInitialFocus)
        : null;
      const target = preferred ?? this.getFocusableElements()[0] ?? this.host;

      target.focus({ preventScroll: true });
    });
  }

  private getFocusableElements(): HTMLElement[] {
    return Array.from(this.host.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (element) => this.isFocusable(element),
    );
  }

  private isFocusable(element: HTMLElement): boolean {
    if (
      element.hidden ||
      element.getAttribute('aria-hidden') === 'true' ||
      element.closest('[inert]') ||
      element.hasAttribute('disabled')
    ) {
      return false;
    }

    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
}
