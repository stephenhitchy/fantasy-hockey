import {
  LEAGUE_SHARE_CARD_SIZE,
  drawLeagueShareFittedText,
  drawLeagueShareRinkBackground,
  drawLeagueShareRoundedRect,
  leagueShareCanvasToPngBlob,
  sharePreparedLeaguePngCard,
  type LeagueShareResult,
} from './league-share-card-browser.util';
import {
  buildLeagueDraftShareFilename,
  buildLeagueDraftShareText,
  normalizeLeagueDraftShareCardData,
  type LeagueDraftShareCardData,
} from './league-share-card-data.util';

export {
  buildLeagueDraftShareFilename,
  buildLeagueDraftShareText,
  normalizeLeagueDraftShareCardData,
} from './league-share-card-data.util';
export type {
  LeagueDraftShareCardData,
  LeagueDraftSharePick,
} from './league-share-card-data.util';

export function createLeagueDraftShareCardBlob(
  source: LeagueDraftShareCardData,
): Blob {
  if (typeof document === 'undefined') {
    throw new Error('Draft share cards are available only in the browser.');
  }

  const data = normalizeLeagueDraftShareCardData(source);
  const canvas = document.createElement('canvas');
  canvas.width = LEAGUE_SHARE_CARD_SIZE;
  canvas.height = LEAGUE_SHARE_CARD_SIZE;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('This browser could not prepare the draft share card.');
  }

  const accent = '#72d8ff';
  const primary = '#f5fbff';
  const muted = '#aac1d2';
  drawLeagueShareRinkBackground(context, accent);

  context.fillStyle = accent;
  context.font = '900 30px Inter, Arial, sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText('RINKRAT DRAFT COMPLETE', 80, 78);

  drawLeagueShareFittedText(
    context,
    data.leagueName,
    1000,
    108,
    760,
    38,
    26,
    primary,
    'right',
    750,
  );

  drawLeagueShareFittedText(
    context,
    data.teamName,
    540,
    220,
    860,
    64,
    36,
    primary,
    'center',
    900,
  );

  drawLeagueShareRoundedRect(context, 290, 280, 500, 74, 37);
  context.fillStyle = 'rgba(5, 15, 24, 0.84)';
  context.fill();
  context.strokeStyle = 'rgba(114, 216, 255, 0.58)';
  context.lineWidth = 2;
  context.stroke();
  drawLeagueShareFittedText(
    context,
    `DRAFT SLOT #${data.draftSlot} OF ${data.totalTeams}`,
    540,
    318,
    450,
    27,
    20,
    accent,
    'center',
    900,
  );

  context.fillStyle = muted;
  context.font = '800 22px Inter, Arial, sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText('CORE PICKS', 126, 408);
  context.textAlign = 'right';
  context.fillText(`${data.totalPicks} TOTAL PICKS`, 954, 408);

  const rowStartY = 458;
  const rowHeight = 78;

  data.picks.forEach((pick, index) => {
    const y = rowStartY + index * rowHeight;
    drawLeagueShareRoundedRect(context, 112, y - 32, 856, 64, 22);
    context.fillStyle = index === 0
      ? 'rgba(114, 216, 255, 0.16)'
      : 'rgba(5, 15, 24, 0.72)';
    context.fill();
    context.strokeStyle = index === 0
      ? 'rgba(114, 216, 255, 0.52)'
      : 'rgba(223, 247, 255, 0.16)';
    context.lineWidth = 2;
    context.stroke();

    drawLeagueShareRoundedRect(context, 128, y - 23, 96, 46, 18);
    context.fillStyle = index === 0 ? accent : 'rgba(114, 216, 255, 0.22)';
    context.fill();
    drawLeagueShareFittedText(
      context,
      `R${pick.round}`,
      176,
      y,
      78,
      20,
      16,
      index === 0 ? '#071523' : primary,
      'center',
      900,
    );

    drawLeagueShareFittedText(
      context,
      pick.name,
      250,
      y,
      530,
      30,
      20,
      primary,
      'left',
      850,
    );

    drawLeagueShareFittedText(
      context,
      pick.position,
      902,
      y - 9,
      90,
      22,
      18,
      accent,
      'right',
      900,
    );
    drawLeagueShareFittedText(
      context,
      `#${pick.overallPick}`,
      902,
      y + 14,
      90,
      16,
      14,
      muted,
      'right',
      750,
    );
  });

  if (data.picks.length === 0) {
    drawLeagueShareFittedText(
      context,
      'The roster is ready for opening night.',
      540,
      612,
      760,
      34,
      22,
      primary,
      'center',
      800,
    );
  }

  context.fillStyle = muted;
  context.font = '750 25px Inter, Arial, sans-serif';
  context.textAlign = 'left';
  context.fillText('Drafted for the six-game grind.', 80, 980);
  context.textAlign = 'right';
  context.fillText('rinkratfantasy.com', 1000, 980);

  return leagueShareCanvasToPngBlob(canvas);
}

export async function shareLeagueDraftCard(
  source: LeagueDraftShareCardData,
): Promise<LeagueShareResult> {
  const data = normalizeLeagueDraftShareCardData(source);
  const blob = createLeagueDraftShareCardBlob(data);

  return sharePreparedLeaguePngCard({
    blob,
    filename: buildLeagueDraftShareFilename(data),
    text: buildLeagueDraftShareText(data),
    title: `${data.teamName} Draft Results`,
    sharedMessage: 'Draft card shared.',
    downloadedMessage: 'Draft card downloaded.',
  });
}
