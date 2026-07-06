import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TeamGoalieLab } from './team-goalie-lab';

describe('TeamGoalieLab', () => {
  let component: TeamGoalieLab;
  let fixture: ComponentFixture<TeamGoalieLab>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TeamGoalieLab],
    }).compileComponents();

    fixture = TestBed.createComponent(TeamGoalieLab);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
