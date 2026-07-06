import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TeamSettings } from './team-settings';

describe('TeamSettings', () => {
  let component: TeamSettings;
  let fixture: ComponentFixture<TeamSettings>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TeamSettings],
    }).compileComponents();

    fixture = TestBed.createComponent(TeamSettings);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
