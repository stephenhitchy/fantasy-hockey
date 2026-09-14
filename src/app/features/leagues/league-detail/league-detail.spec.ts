import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { LeagueDetail } from './league-detail';
import type { League } from '../../../core/league/league.service';
import type { FantasyDraft } from '../../../core/draft/draft.models';

describe('LeagueDetail', () => {
  let component: LeagueDetail;
  let fixture: ComponentFixture<LeagueDetail>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LeagueDetail],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(LeagueDetail);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('offers an explicit capacity reset only for a scheduled Draft more than 24 hours away', () => {
    const now = Date.now();
    component.now.set(now);
    component.isCommissioner.set(true);
    component.league.set({
      teamCount: 2,
      joinStatus: 'locked',
      joinLockedReason: 'draft-order-saved',
      maxTeams: 2,
    } as League);
    component.draft.set({
      status: 'scheduled',
      clockStatus: 'stopped',
      nextOverallPick: 1,
      draftedAssetKeys: [],
      roundOneOrder: ['owner-one', 'owner-two'],
      lastSettingsSubmissionId: 'settings-current-submission',
      scheduledStartAt: new Date(now + 48 * 60 * 60 * 1000),
    } as unknown as FantasyDraft);

    expect(component.preDraftMemberRemovalAvailable()).toBe(false);
    expect(component.scheduledCapacityReopenAvailable()).toBe(true);
    expect(component.capacityChangeAvailable()).toBe(true);

    component.now.set(now + 24 * 60 * 60 * 1000);
    expect(component.scheduledCapacityReopenAvailable()).toBe(false);
    expect(component.capacityAvailabilityMessage()).toContain('frozen within 24 hours');
  });
});
