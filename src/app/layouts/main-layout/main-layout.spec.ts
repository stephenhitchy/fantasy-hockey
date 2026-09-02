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
});
