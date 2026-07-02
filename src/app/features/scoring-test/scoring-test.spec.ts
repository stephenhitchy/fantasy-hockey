import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ScoringTest } from './scoring-test';

describe('ScoringTest', () => {
  let component: ScoringTest;
  let fixture: ComponentFixture<ScoringTest>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ScoringTest],
    }).compileComponents();

    fixture = TestBed.createComponent(ScoringTest);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
