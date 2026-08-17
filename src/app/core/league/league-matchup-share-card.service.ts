export interface LeagueMatchupShareCardData {
  leagueName: string;
  teamAName: string;
  teamBName: string;
  teamAScore: number;
  teamBScore: number;
  winnerTeamName: string | null;
  contextLabel: string;
  championship: boolean;
  tieBrokenByHigherSeed: boolean;
}

export type LeagueMatchupShareOutcome =
  | 'shared'
  | 'downloaded'
  | 'cancelled';

export interface LeagueMatchupShareResult {
  outcome: LeagueMatchupShareOutcome;
  message: string;
}

const SHARE_CARD_SIZE = 1080;
const SHARE_SITE_URL = 'https://rinkratfantasy.com';
const DEFAULT_LEAGUE_NAME = 'RinkRat League';

function normalizeText(value: string, maximumLength: number, fallback: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return fallback;
  }

  return normalized.length <= maximumLength
    ? normalized
    : `${normalized.slice(0, Math.max(1, maximumLength - 1)).trimEnd()}…`;
}

function formatScore(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }

  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return slug || 'rinkrat-final';
}

export function normalizeLeagueMatchupShareCardData(
  data: LeagueMatchupShareCardData,
): LeagueMatchupShareCardData {
  return {
    leagueName: normalizeText(data.leagueName, 72, DEFAULT_LEAGUE_NAME),
    teamAName: normalizeText(data.teamAName, 56, 'Team A'),
    teamBName: normalizeText(data.teamBName, 56, 'Team B'),
    teamAScore: Number.isFinite(data.teamAScore) ? data.teamAScore : 0,
    teamBScore: Number.isFinite(data.teamBScore) ? data.teamBScore : 0,
    winnerTeamName: data.winnerTeamName
      ? normalizeText(data.winnerTeamName, 56, 'Winner')
      : null,
    contextLabel: normalizeText(data.contextLabel, 44, 'Game Final'),
    championship: Boolean(data.championship),
    tieBrokenByHigherSeed: Boolean(data.tieBrokenByHigherSeed),
  };
}

export function buildLeagueMatchupShareText(
  source: LeagueMatchupShareCardData,
): string {
  const data = normalizeLeagueMatchupShareCardData(source);
  const scoreLine = `${data.teamAName} ${formatScore(data.teamAScore)}–${formatScore(data.teamBScore)} ${data.teamBName}`;
  const resultLine = data.championship && data.winnerTeamName
    ? `${data.winnerTeamName} won the RinkRat Championship.`
    : data.winnerTeamName
      ? `${data.winnerTeamName} won ${data.contextLabel}.`
      : `${data.contextLabel} finished tied.`;
  const tiebreakLine = data.tieBrokenByHigherSeed
    ? '\nHigher seed advanced.'
    : '';

  return `${resultLine}\n${scoreLine}\n${data.leagueName}${tiebreakLine}\n${SHARE_SITE_URL}`;
}

export function buildLeagueMatchupShareFilename(
  source: LeagueMatchupShareCardData,
): string {
  const data = normalizeLeagueMatchupShareCardData(source);
  const identifier = data.championship && data.winnerTeamName
    ? `${data.winnerTeamName}-champion`
    : `${data.teamAName}-vs-${data.teamBName}`;

  return `${slugify(identifier)}-rinkrat.png`;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);

  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - safeRadius,
    y + height,
  );
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function fittedFontSize(
  context: CanvasRenderingContext2D,
  value: string,
  maximumWidth: number,
  startingSize: number,
  minimumSize: number,
  weight = 800,
): number {
  let size = startingSize;

  while (size > minimumSize) {
    context.font = `${weight} ${size}px Inter, Arial, sans-serif`;
    if (context.measureText(value).width <= maximumWidth) {
      return size;
    }
    size -= 2;
  }

  return minimumSize;
}

function drawFittedText(
  context: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  maximumWidth: number,
  startingSize: number,
  minimumSize: number,
  color: string,
  align: CanvasTextAlign,
  weight = 800,
): void {
  const size = fittedFontSize(
    context,
    value,
    maximumWidth,
    startingSize,
    minimumSize,
    weight,
  );

  context.font = `${weight} ${size}px Inter, Arial, sans-serif`;
  context.fillStyle = color;
  context.textAlign = align;
  context.textBaseline = 'middle';
  context.fillText(value, x, y, maximumWidth);
}

function drawRinkBackground(context: CanvasRenderingContext2D): void {
  const background = context.createLinearGradient(0, 0, SHARE_CARD_SIZE, SHARE_CARD_SIZE);
  background.addColorStop(0, '#071523');
  background.addColorStop(0.55, '#10273a');
  background.addColorStop(1, '#06111c');
  context.fillStyle = background;
  context.fillRect(0, 0, SHARE_CARD_SIZE, SHARE_CARD_SIZE);

  context.save();
  context.globalAlpha = 0.18;
  roundedRect(context, 68, 156, 944, 760, 76);
  context.fillStyle = '#dff7ff';
  context.fill();
  context.restore();

  context.save();
  roundedRect(context, 78, 166, 924, 740, 68);
  context.strokeStyle = 'rgba(223, 247, 255, 0.46)';
  context.lineWidth = 5;
  context.stroke();

  context.strokeStyle = 'rgba(69, 172, 225, 0.34)';
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(540, 170);
  context.lineTo(540, 902);
  context.stroke();

  context.strokeStyle = 'rgba(230, 73, 84, 0.42)';
  context.lineWidth = 6;
  context.beginPath();
  context.moveTo(300, 170);
  context.lineTo(300, 902);
  context.moveTo(780, 170);
  context.lineTo(780, 902);
  context.stroke();

  context.beginPath();
  context.arc(540, 536, 102, 0, Math.PI * 2);
  context.strokeStyle = 'rgba(69, 172, 225, 0.24)';
  context.lineWidth = 5;
  context.stroke();
  context.restore();
}

function drawPuck(context: CanvasRenderingContext2D, x: number, y: number): void {
  context.save();
  context.beginPath();
  context.ellipse(x, y + 12, 34, 15, 0, 0, Math.PI * 2);
  context.fillStyle = 'rgba(0, 0, 0, 0.32)';
  context.fill();

  context.beginPath();
  context.ellipse(x, y, 32, 14, 0, 0, Math.PI * 2);
  context.fillStyle = '#05090d';
  context.fill();
  context.strokeStyle = '#72d8ff';
  context.lineWidth = 3;
  context.stroke();
  context.restore();
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Blob {
  const dataUrl = canvas.toDataURL('image/png');
  const commaIndex = dataUrl.indexOf(',');

  if (commaIndex < 0 || !dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error('The share card image could not be created.');
  }

  const binary = atob(dataUrl.slice(commaIndex + 1));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: 'image/png' });
}

export function createLeagueMatchupShareCardBlob(
  source: LeagueMatchupShareCardData,
): Blob {
  if (typeof document === 'undefined') {
    throw new Error('Share cards are available only in the browser.');
  }

  const data = normalizeLeagueMatchupShareCardData(source);
  const canvas = document.createElement('canvas');
  canvas.width = SHARE_CARD_SIZE;
  canvas.height = SHARE_CARD_SIZE;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('This browser could not prepare the share card.');
  }

  drawRinkBackground(context);

  const accent = data.championship ? '#ffd56a' : '#72d8ff';
  const muted = '#aac1d2';
  const primary = '#f5fbff';

  context.fillStyle = accent;
  context.font = '900 30px Inter, Arial, sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(data.championship ? 'RINKRAT CHAMPION' : 'RINKRAT GAME FINAL', 80, 78);

  drawFittedText(
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

  roundedRect(context, 292, 196, 496, 58, 29);
  context.fillStyle = 'rgba(5, 15, 24, 0.82)';
  context.fill();
  drawFittedText(context, data.contextLabel.toUpperCase(), 540, 226, 450, 26, 20, accent, 'center', 900);

  const winnerIsTeamA = data.winnerTeamName === data.teamAName;
  const winnerIsTeamB = data.winnerTeamName === data.teamBName;

  if (winnerIsTeamA || winnerIsTeamB) {
    const winnerX = winnerIsTeamA ? 282 : 798;
    roundedRect(context, winnerX - 104, 296, 208, 48, 24);
    context.fillStyle = data.championship
      ? 'rgba(255, 213, 106, 0.92)'
      : 'rgba(114, 216, 255, 0.92)';
    context.fill();
    drawFittedText(
      context,
      data.championship ? 'CHAMPION' : 'WINNER',
      winnerX,
      321,
      170,
      23,
      18,
      '#071523',
      'center',
      950,
    );
  }

  drawFittedText(context, data.teamAName, 282, 414, 400, 50, 28, primary, 'center', 850);
  drawFittedText(context, data.teamBName, 798, 414, 400, 50, 28, primary, 'center', 850);

  drawFittedText(
    context,
    formatScore(data.teamAScore),
    282,
    578,
    380,
    154,
    86,
    winnerIsTeamA ? accent : primary,
    'center',
    950,
  );
  drawFittedText(
    context,
    formatScore(data.teamBScore),
    798,
    578,
    380,
    154,
    86,
    winnerIsTeamB ? accent : primary,
    'center',
    950,
  );

  drawPuck(context, 540, 565);
  drawFittedText(
    context,
    data.winnerTeamName ? 'FINAL' : 'TIE',
    540,
    652,
    180,
    30,
    22,
    muted,
    'center',
    900,
  );

  if (data.tieBrokenByHigherSeed) {
    roundedRect(context, 300, 736, 480, 60, 30);
    context.fillStyle = 'rgba(255, 213, 106, 0.14)';
    context.fill();
    context.strokeStyle = 'rgba(255, 213, 106, 0.55)';
    context.lineWidth = 2;
    context.stroke();
    drawFittedText(
      context,
      'HIGHER SEED ADVANCED',
      540,
      767,
      430,
      24,
      18,
      '#ffe59d',
      'center',
      900,
    );
  }

  context.fillStyle = muted;
  context.font = '750 25px Inter, Arial, sans-serif';
  context.textAlign = 'left';
  context.fillText('Fantasy hockey built differently.', 80, 980);
  context.textAlign = 'right';
  context.fillText('rinkratfantasy.com', 1000, 980);

  return canvasToPngBlob(canvas);
}

function triggerDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

function isShareCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function shareLeagueMatchupCard(
  source: LeagueMatchupShareCardData,
): Promise<LeagueMatchupShareResult> {
  const data = normalizeLeagueMatchupShareCardData(source);
  const blob = createLeagueMatchupShareCardBlob(data);
  const filename = buildLeagueMatchupShareFilename(data);
  const text = buildLeagueMatchupShareText(data);
  const file = typeof File === 'function'
    ? new File([blob], filename, { type: 'image/png' })
    : null;
  const title = data.championship
    ? `${data.winnerTeamName ?? 'RinkRat'} Championship Final`
    : `${data.contextLabel} Final`;

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    const canShareFile = file !== null &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] });

    try {
      if (canShareFile && file) {
        await navigator.share({ title, text, files: [file] });
      } else {
        await navigator.share({ title, text, url: SHARE_SITE_URL });
      }

      return {
        outcome: 'shared',
        message: 'Result card shared.',
      };
    } catch (error) {
      if (isShareCancellation(error)) {
        return {
          outcome: 'cancelled',
          message: '',
        };
      }

      // A browser may advertise Web Share but reject a file or invocation at
      // runtime. The local PNG fallback keeps the manager's action recoverable.
    }
  }

  triggerDownload(blob, filename);

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return {
        outcome: 'downloaded',
        message: 'Share card downloaded and its caption copied.',
      };
    } catch {
      // The image download already completed, so clipboard permission is optional.
    }
  }

  return {
    outcome: 'downloaded',
    message: 'Share card downloaded.',
  };
}
