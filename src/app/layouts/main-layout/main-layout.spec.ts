import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { MainLayout } from './main-layout';

describe('MainLayout', () => {
  let component: MainLayout;
  let fixture: ComponentFixture<MainLayout>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MainLayout],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(MainLayout);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('repairs an initial route focus attempt that ran before the view existed', () => {
    const mainContent = fixture.nativeElement.querySelector('#main-content') as HTMLElement;
    const focusInternals = component as unknown as {
      mainContent?: { nativeElement: HTMLElement };
      focusRouteHeadingOrMain: () => void;
    };
    const resetTarget = document.createElement('button');
    document.body.appendChild(resetTarget);
    resetTarget.focus();
    resetTarget.remove();

    focusInternals.mainContent = undefined;
    focusInternals.focusRouteHeadingOrMain();

    expect(document.activeElement).toBe(document.body);

    focusInternals.mainContent = { nativeElement: mainContent };
    component.ngAfterViewInit();

    expect(document.activeElement).toBe(mainContent);
  });

  it('does not repair missed route focus after another control receives focus', () => {
    const mainContent = fixture.nativeElement.querySelector('#main-content') as HTMLElement;
    const focusInternals = component as unknown as {
      mainContent?: { nativeElement: HTMLElement };
      focusRouteHeadingOrMain: () => void;
    };
    const userTarget = document.createElement('button');
    document.body.appendChild(userTarget);

    focusInternals.mainContent = undefined;
    focusInternals.focusRouteHeadingOrMain();
    userTarget.focus();

    focusInternals.mainContent = { nativeElement: mainContent };
    component.ngAfterViewInit();

    expect(document.activeElement).toBe(userTarget);
    userTarget.remove();
  });

  it('moves focus to the stable route heading when a loading heading is replaced', async () => {
    const mainContent = fixture.nativeElement.querySelector('#main-content') as HTMLElement;
    const focusInternals = component as unknown as {
      mainContent?: { nativeElement: HTMLElement };
      focusRouteHeadingOrMain: () => void;
    };
    const loadingHeading = document.createElement('h1');
    loadingHeading.textContent = 'Opening the Draft Room…';
    mainContent.replaceChildren(loadingHeading);
    focusInternals.mainContent = { nativeElement: mainContent };

    focusInternals.focusRouteHeadingOrMain();
    expect(document.activeElement).toBe(loadingHeading);

    const stableHeading = document.createElement('h1');
    stableHeading.textContent = 'D1N Capacity Fixture';
    mainContent.replaceChildren(stableHeading);
    await Promise.resolve();

    expect(document.activeElement).toBe(stableHeading);
  });

  it('does not steal focus after a manager reaches a route control', async () => {
    const mainContent = fixture.nativeElement.querySelector('#main-content') as HTMLElement;
    const focusInternals = component as unknown as {
      mainContent?: { nativeElement: HTMLElement };
      focusRouteHeadingOrMain: () => void;
    };
    const loadingHeading = document.createElement('h1');
    const managerControl = document.createElement('button');
    loadingHeading.textContent = 'Opening the Draft Room…';
    managerControl.textContent = 'Manager action';
    mainContent.replaceChildren(loadingHeading, managerControl);
    focusInternals.mainContent = { nativeElement: mainContent };

    focusInternals.focusRouteHeadingOrMain();
    managerControl.focus();
    const stableHeading = document.createElement('h1');
    stableHeading.textContent = 'D1N Capacity Fixture';
    loadingHeading.replaceWith(stableHeading);
    await Promise.resolve();

    expect(document.activeElement).toBe(managerControl);
  });
});
