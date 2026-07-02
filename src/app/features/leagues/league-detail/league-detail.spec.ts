import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LeagueDetail } from './league-detail';

describe('LeagueDetail', () => {
  let component: LeagueDetail;
  let fixture: ComponentFixture<LeagueDetail>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LeagueDetail],
    }).compileComponents();

    fixture = TestBed.createComponent(LeagueDetail);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
