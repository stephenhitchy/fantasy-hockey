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

const activeViewportOverlays = new Set<HTMLElement>();
let lockedScrollX = 0;
let lockedScrollY = 0;
let bodyStyleSnapshot: InlineStyleSnapshot | null = null;
let htmlOverflowSnapshot = '';
let overlayMutationObserver: MutationObserver | null = null;
let globalRecoveryListenersInstalled = false;

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

function restoreViewportScrollLock(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  if (!bodyStyleSnapshot) {
    document.body.classList.remove('rr-viewport-overlay-open');
    document.documentElement.style.overflow = htmlOverflowSnapshot;
    return;
  }

  const body = document.body;
  const html = document.documentElement;
  const scrollX = lockedScrollX;
  const scrollY = lockedScrollY;

  restoreBodyStyle(body, bodyStyleSnapshot);
  html.style.overflow = htmlOverflowSnapshot;
  body.classList.remove('rr-viewport-overlay-open');

  bodyStyleSnapshot = null;
  htmlOverflowSnapshot = '';
  lockedScrollX = 0;
  lockedScrollY = 0;

  window.requestAnimationFrame(() => {
    window.scrollTo(scrollX, scrollY);
  });
}

/**
 * Removes overlay entries whose Angular view has already disappeared.
 *
 * Safari occasionally preserves body-lock styles after an overlay view is
 * torn down during a route change or a delayed async callback. A Set of the
 * actual overlay nodes is safer than a blind counter because disconnected
 * nodes can be pruned and the page can recover automatically.
 */
export function repairViewportOverlayLock(): void {
  if (typeof document === 'undefined') {
    return;
  }

  for (const overlay of [...activeViewportOverlays]) {
    if (!overlay.isConnected || overlay.getAttribute('data-viewport-overlay-portaled') !== 'true') {
      activeViewportOverlays.delete(overlay);
    }
  }

  if (activeViewportOverlays.size === 0) {
    restoreViewportScrollLock();
  }
}

function installOverlayRecoveryWatchers(): void {
  if (
    globalRecoveryListenersInstalled ||
    typeof document === 'undefined' ||
    typeof window === 'undefined' ||
    typeof MutationObserver === 'undefined'
  ) {
    return;
  }

  globalRecoveryListenersInstalled = true;

  overlayMutationObserver = new MutationObserver(() => {
    queueMicrotask(repairViewportOverlayLock);
  });
  overlayMutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  window.addEventListener('pageshow', repairViewportOverlayLock);
  window.addEventListener('pagehide', repairViewportOverlayLock);
  window.addEventListener('popstate', repairViewportOverlayLock);
  window.addEventListener('hashchange', repairViewportOverlayLock);
  document.addEventListener('visibilitychange', repairViewportOverlayLock);
}

function acquireViewportLock(host: HTMLElement): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  installOverlayRecoveryWatchers();
  repairViewportOverlayLock();

  if (activeViewportOverlays.has(host)) {
    return;
  }

  if (activeViewportOverlays.size === 0) {
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

  activeViewportOverlays.add(host);
}

function releaseViewportLock(host: HTMLElement): void {
  activeViewportOverlays.delete(host);
  repairViewportOverlayLock();
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
    acquireViewportLock(this.host);

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
    releaseViewportLock(this.host);
  }
}
