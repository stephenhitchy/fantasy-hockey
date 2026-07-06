import { ComponentFixture, TestBed } from '@angular/core/testing';

import { JoinLeague } from './join-league';

describe('JoinLeague', () => {
  let component: JoinLeague;
  let fixture: ComponentFixture<JoinLeague>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [JoinLeague],
    }).compileComponents();

    fixture = TestBed.createComponent(JoinLeague);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
