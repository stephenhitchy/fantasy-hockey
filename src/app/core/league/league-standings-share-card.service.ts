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
  buildLeagueStandingsShareFilename,
  buildLeagueStandingsShareText,
  formatLeagueShareNumber,
  normalizeLeagueStandingsShareCardData,
  type LeagueStandingsShareCardData,
} from './league-share-card-data.util';

export {
  buildLeagueStandingsShareFilename,
  buildLeagueStandingsShareText,
  normalizeLeagueStandingsShareCardData,
} from './league-share-card-data.util';
export type {
  LeagueStandingsShareCardData,
  LeagueStandingsShareRow,
} from './league-share-card-data.util';

function drawHeaderLabels(context: CanvasRenderingContext2D): void {
  const muted = '#aac1d2';
  context.fillStyle = muted;
  context.font = '800 18px Inter, Arial, sans-serif';
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  context.fillText('TEAM', 190, 390);
  context.textAlign = 'center';
  context.fillText('RECORD', 720, 390);
  context.fillText('PF', 842, 390);
  context.textAlign = 'right';
  context.fillText('DIFF', 950, 390);
}

export function createLeagueStandingsShareCardBlob(
  source: LeagueStandingsShareCardData,
): Blob {
  if (typeof document === 'undefined') {
    throw new Error('Standings share cards are available only in the browser.');
  }

  const data = normalizeLeagueStandingsShareCardData(source);
  const canvas = document.createElement('canvas');
  canvas.width = LEAGUE_SHARE_CARD_SIZE;
  canvas.height = LEAGUE_SHARE_CARD_SIZE;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('This browser could not prepare the standings share card.');
  }

  const accent = '#72d8ff';
  const primary = '#f5fbff';
  const muted = '#aac1d2';
  const playoffAccent = '#ffd56a';
  drawLeagueShareRinkBackground(context, accent);

  context.fillStyle = accent;
  context.font = '900 30px Inter, Arial, sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText('RINKRAT STANDINGS', 80, 78);

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
    data.leagueName,
    540,
    220,
    860,
    60,
    34,
    primary,
    'center',
    900,
  );

  drawLeagueShareRoundedRect(context, 318, 278, 444, 64, 32);
  context.fillStyle = 'rgba(5, 15, 24, 0.84)';
  context.fill();
  context.strokeStyle = 'rgba(114, 216, 255, 0.52)';
  context.lineWidth = 2;
  context.stroke();
  drawLeagueShareFittedText(
    context,
    data.periodLabel.toUpperCase(),
    540,
    311,
    396,
    24,
    18,
    accent,
    'center',
    900,
  );

  drawHeaderLabels(context);

  const rowStartY = 432;
  const rowHeight = 59;

  data.rows.forEach((row, index) => {
    const y = rowStartY + index * rowHeight;
    const isLeader = row.rank === 1;
    const isCutLine = row.rank === data.playoffTeamCount;

    drawLeagueShareRoundedRect(context, 104, y - 27, 872, 54, 18);
    context.fillStyle = isLeader
      ? 'rgba(255, 213, 106, 0.18)'
      : row.currentManager
        ? 'rgba(114, 216, 255, 0.16)'
        : 'rgba(5, 15, 24, 0.70)';
    context.fill();
    context.strokeStyle = isLeader
      ? 'rgba(255, 213, 106, 0.54)'
      : row.currentManager
        ? 'rgba(114, 216, 255, 0.48)'
        : 'rgba(223, 247, 255, 0.14)';
    context.lineWidth = 2;
    context.stroke();

    drawLeagueShareRoundedRect(context, 120, y - 20, 48, 40, 16);
    context.fillStyle = isLeader ? playoffAccent : 'rgba(114, 216, 255, 0.20)';
    context.fill();
    drawLeagueShareFittedText(
      context,
      `#${row.rank}`,
      144,
      y,
      42,
      17,
      14,
      isLeader ? '#071523' : primary,
      'center',
      900,
    );

    drawLeagueShareFittedText(
      context,
      row.teamName,
      190,
      y,
      430,
      25,
      18,
      primary,
      'left',
      row.currentManager ? 900 : 800,
    );
    drawLeagueShareFittedText(
      context,
      row.record,
      720,
      y,
      100,
      20,
      16,
      row.playoffQualifier ? playoffAccent : primary,
      'center',
      850,
    );
    drawLeagueShareFittedText(
      context,
      formatLeagueShareNumber(row.pointsFor, 1),
      842,
      y,
      82,
      20,
      16,
      primary,
      'center',
      800,
    );
    drawLeagueShareFittedText(
      context,
      `${row.pointDifferential > 0 ? '+' : ''}${formatLeagueShareNumber(row.pointDifferential, 1)}`,
      950,
      y,
      88,
      20,
      16,
      row.pointDifferential >= 0 ? '#7ee7a9' : '#ff9ca6',
      'right',
      850,
    );

    if (isCutLine && row.rank < data.totalTeams) {
      context.save();
      context.strokeStyle = 'rgba(255, 213, 106, 0.58)';
      context.lineWidth = 2;
      context.setLineDash([10, 8]);
      context.beginPath();
      context.moveTo(122, y + 32);
      context.lineTo(958, y + 32);
      context.stroke();
      context.restore();
    }
  });

  const hiddenTeamCount = Math.max(0, data.totalTeams - data.rows.length);
  const footerSummary = hiddenTeamCount > 0
    ? `TOP ${data.rows.length} OF ${data.totalTeams} TEAMS · ${hiddenTeamCount} MORE IN RINKRAT`
    : `ALL ${data.totalTeams} TEAMS · GOLD MARKS THE PLAYOFF LINE`;

  drawLeagueShareFittedText(
    context,
    footerSummary,
    540,
    920,
    820,
    20,
    15,
    muted,
    'center',
    800,
  );

  context.fillStyle = muted;
  context.font = '750 25px Inter, Arial, sans-serif';
  context.textAlign = 'left';
  context.fillText('Every matchup matters.', 80, 980);
  context.textAlign = 'right';
  context.fillText('rinkratfantasy.com', 1000, 980);

  return leagueShareCanvasToPngBlob(canvas);
}

export async function shareLeagueStandingsCard(
  source: LeagueStandingsShareCardData,
): Promise<LeagueShareResult> {
  const data = normalizeLeagueStandingsShareCardData(source);
  const blob = createLeagueStandingsShareCardBlob(data);

  return sharePreparedLeaguePngCard({
    blob,
    filename: buildLeagueStandingsShareFilename(data),
    text: buildLeagueStandingsShareText(data),
    title: `${data.leagueName} Standings`,
    sharedMessage: 'Standings card shared.',
    downloadedMessage: 'Standings card downloaded.',
  });
}
