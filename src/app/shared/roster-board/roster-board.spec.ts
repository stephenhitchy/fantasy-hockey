import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RosterBoard } from './roster-board';

describe('RosterBoard', () => {
  let component: RosterBoard;
  let fixture: ComponentFixture<RosterBoard>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RosterBoard],
    }).compileComponents();

    fixture = TestBed.createComponent(RosterBoard);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
