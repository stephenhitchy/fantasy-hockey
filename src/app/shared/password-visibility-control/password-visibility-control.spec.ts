import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PasswordVisibilityControl } from './password-visibility-control';

@Component({
  standalone: true,
  imports: [PasswordVisibilityControl],
  template: `
    <app-password-visibility-control passwordName="current password">
      <input
        id="test-password"
        type="password"
        value="Secret123!"
        [disabled]="disabled()"
      />
    </app-password-visibility-control>
  `,
})
class PasswordVisibilityControlTestHost {
  readonly disabled = signal(false);
}

describe('PasswordVisibilityControl', () => {
  let fixture: ComponentFixture<PasswordVisibilityControlTestHost>;
  let input: HTMLInputElement;
  let button: HTMLButtonElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PasswordVisibilityControlTestHost],
    }).compileComponents();

    fixture = TestBed.createComponent(PasswordVisibilityControlTestHost);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    input = fixture.nativeElement.querySelector('input');
    button = fixture.nativeElement.querySelector('button');
  });

  it('reveals and conceals without changing the password value or submitting a form', () => {
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-controls')).toBe('test-password');
    expect(button.getAttribute('aria-label')).toBe('Show current password');
    expect(button.getAttribute('aria-pressed')).toBe('false');

    button.click();
    fixture.detectChanges();

    expect(input.type).toBe('text');
    expect(input.value).toBe('Secret123!');
    expect(button.getAttribute('aria-label')).toBe('Hide current password');
    expect(button.getAttribute('aria-pressed')).toBe('true');

    button.click();
    fixture.detectChanges();

    expect(input.type).toBe('password');
    expect(input.value).toBe('Secret123!');
  });

  it('does not reveal a disabled password input', async () => {
    button.click();
    fixture.detectChanges();
    expect(input.type).toBe('text');

    fixture.componentInstance.disabled.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(button.disabled).toBe(true);
    expect(input.type).toBe('password');
    button.click();
    fixture.detectChanges();
    expect(input.type).toBe('password');
  });
});
