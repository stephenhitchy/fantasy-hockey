import {
  AfterViewInit,
  Directive,
  ElementRef,
  OnDestroy,
} from '@angular/core';

interface InlineStyleSnapshot {
  position: string;
  top: string;
  right: string;
  bottom: string;
  left: string;
  width: string;
  overflow: string;
  paddingRight: string;
}

let activeViewportOverlayCount = 0;
let lockedScrollX = 0;
let lockedScrollY = 0;
let bodyStyleSnapshot: InlineStyleSnapshot | null = null;
let htmlOverflowSnapshot = '';

function captureBodyStyle(body: HTMLElement): InlineStyleSnapshot {
  return {
    position: body.style.position,
    top: body.style.top,
    right: body.style.right,
    bottom: body.style.bottom,
    left: body.style.left,
    width: body.style.width,
    overflow: body.style.overflow,
    paddingRight: body.style.paddingRight,
  };
}

function restoreBodyStyle(body: HTMLElement, snapshot: InlineStyleSnapshot): void {
  body.style.position = snapshot.position;
  body.style.top = snapshot.top;
  body.style.right = snapshot.right;
  body.style.bottom = snapshot.bottom;
  body.style.left = snapshot.left;
  body.style.width = snapshot.width;
  body.style.overflow = snapshot.overflow;
  body.style.paddingRight = snapshot.paddingRight;
}

function acquireViewportLock(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  if (activeViewportOverlayCount === 0) {
    const body = document.body;
    const html = document.documentElement;

    lockedScrollX = window.scrollX;
    lockedScrollY = window.scrollY;
    bodyStyleSnapshot = captureBodyStyle(body);
    htmlOverflowSnapshot = html.style.overflow;

    const scrollbarCompensation = Math.max(0, window.innerWidth - html.clientWidth);
    const existingPaddingRight = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;

    body.style.position = 'fixed';
    body.style.top = `${-lockedScrollY}px`;
    body.style.right = '0';
    body.style.bottom = '0';
    body.style.left = `${-lockedScrollX}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';

    if (scrollbarCompensation > 0) {
      body.style.paddingRight = `${existingPaddingRight + scrollbarCompensation}px`;
    }

    html.style.overflow = 'hidden';
    body.classList.add('rr-viewport-overlay-open');
  }

  activeViewportOverlayCount += 1;
}

function releaseViewportLock(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  activeViewportOverlayCount = Math.max(0, activeViewportOverlayCount - 1);

  if (activeViewportOverlayCount > 0) {
    return;
  }

  const body = document.body;
  const html = document.documentElement;

  if (bodyStyleSnapshot) {
    restoreBodyStyle(body, bodyStyleSnapshot);
  }

  html.style.overflow = htmlOverflowSnapshot;
  body.classList.remove('rr-viewport-overlay-open');

  const scrollX = lockedScrollX;
  const scrollY = lockedScrollY;

  bodyStyleSnapshot = null;
  htmlOverflowSnapshot = '';
  lockedScrollX = 0;
  lockedScrollY = 0;

  window.requestAnimationFrame(() => {
    window.scrollTo(scrollX, scrollY);
  });
}

/**
 * Moves a fixed-position overlay directly under document.body.
 *
 * Safari treats a fixed descendant of transformed, filtered, or isolated page
 * surfaces as fixed to that surface instead of to the visual viewport. That can
 * leave only the blurred backdrop visible while the dialog itself is rendered
 * far below the user's current scroll position. Portaling the existing DOM node
 * preserves Angular bindings while restoring true viewport positioning.
 */
@Directive({
  selector: '[appViewportOverlayPortal]',
  standalone: true,
})
export class ViewportOverlayPortalDirective implements AfterViewInit, OnDestroy {
  private readonly host: HTMLElement;
  private originalParent: Node | null = null;
  private originalNextSibling: Node | null = null;
  private resetFrame: number | null = null;
  private portaled = false;

  constructor(elementRef: ElementRef<HTMLElement>) {
    this.host = elementRef.nativeElement;
  }

  ngAfterViewInit(): void {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }

    this.originalParent = this.host.parentNode;
    this.originalNextSibling = this.host.nextSibling;

    document.body.appendChild(this.host);
    this.host.setAttribute('data-viewport-overlay-portaled', 'true');
    this.portaled = true;
    acquireViewportLock();

    this.resetFrame = window.requestAnimationFrame(() => {
      this.resetFrame = null;

      const scrollRoot =
        this.host.matches('[data-overlay-scroll-root]')
          ? this.host
          : this.host.querySelector<HTMLElement>('[data-overlay-scroll-root]');

      if (scrollRoot) {
        scrollRoot.scrollTop = 0;
        scrollRoot.scrollLeft = 0;
      }
    });
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined' && this.resetFrame !== null) {
      window.cancelAnimationFrame(this.resetFrame);
      this.resetFrame = null;
    }

    if (!this.portaled) {
      return;
    }

    this.host.removeAttribute('data-viewport-overlay-portaled');

    if (this.originalParent?.isConnected) {
      const nextSibling = this.originalNextSibling?.parentNode === this.originalParent
        ? this.originalNextSibling
        : null;

      this.originalParent.insertBefore(this.host, nextSibling);
    } else {
      this.host.remove();
    }

    this.portaled = false;
    releaseViewportLock();
  }
}
