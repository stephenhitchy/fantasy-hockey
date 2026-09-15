import { LeagueJoinConfirmationService } from './league-join-confirmation.service';

describe('LeagueJoinConfirmationService', () => {
  it('keeps one confirmed league available until the person dismisses it', () => {
    const service = new LeagueJoinConfirmationService();

    service.confirm(' league-one ');
    expect(service.current()).toEqual({ leagueId: 'league-one' });

    service.dismiss();
    expect(service.current()).toBeNull();
  });

  it('ignores an empty league identity', () => {
    const service = new LeagueJoinConfirmationService();

    service.confirm('   ');

    expect(service.current()).toBeNull();
  });
});
