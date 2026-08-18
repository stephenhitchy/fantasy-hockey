import { LEAGUE_SHARE_SITE_URL } from './league-share-card-data.util';

export {
  LEAGUE_SHARE_SITE_URL,
  formatLeagueShareNumber,
  normalizeLeagueShareText,
  slugifyLeagueShareValue,
} from './league-share-card-data.util';

export type LeagueShareOutcome = 'shared' | 'downloaded' | 'cancelled';

export interface LeagueShareResult {
  outcome: LeagueShareOutcome;
  message: string;
}

export interface SharePreparedPngCardOptions {
  blob: Blob;
  filename: string;
  text: string;
  title: string;
  sharedMessage: string;
  downloadedMessage: string;
}

export const LEAGUE_SHARE_CARD_SIZE = 1080;

export function drawLeagueShareRoundedRect(
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
  weight: number,
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

export function drawLeagueShareFittedText(
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

export function drawLeagueShareRinkBackground(
  context: CanvasRenderingContext2D,
  accent = '#72d8ff',
): void {
  const background = context.createLinearGradient(
    0,
    0,
    LEAGUE_SHARE_CARD_SIZE,
    LEAGUE_SHARE_CARD_SIZE,
  );
  background.addColorStop(0, '#071523');
  background.addColorStop(0.54, '#10273a');
  background.addColorStop(1, '#06111c');
  context.fillStyle = background;
  context.fillRect(0, 0, LEAGUE_SHARE_CARD_SIZE, LEAGUE_SHARE_CARD_SIZE);

  context.save();
  context.globalAlpha = 0.12;
  drawLeagueShareRoundedRect(context, 60, 150, 960, 780, 78);
  context.fillStyle = '#dff7ff';
  context.fill();
  context.restore();

  context.save();
  drawLeagueShareRoundedRect(context, 70, 160, 940, 760, 70);
  context.strokeStyle = 'rgba(223, 247, 255, 0.36)';
  context.lineWidth = 5;
  context.stroke();

  context.strokeStyle = `${accent}55`;
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(540, 164);
  context.lineTo(540, 916);
  context.stroke();

  context.strokeStyle = 'rgba(230, 73, 84, 0.32)';
  context.lineWidth = 5;
  context.beginPath();
  context.moveTo(300, 164);
  context.lineTo(300, 916);
  context.moveTo(780, 164);
  context.lineTo(780, 916);
  context.stroke();
  context.restore();
}

export function leagueShareCanvasToPngBlob(canvas: HTMLCanvasElement): Blob {
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

function triggerLeagueShareDownload(blob: Blob, filename: string): void {
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

export async function sharePreparedLeaguePngCard(
  options: SharePreparedPngCardOptions,
): Promise<LeagueShareResult> {
  const file = typeof File === 'function'
    ? new File([options.blob], options.filename, { type: 'image/png' })
    : null;

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    const canShareFile = file !== null &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] });

    try {
      if (canShareFile && file) {
        await navigator.share({
          title: options.title,
          text: options.text,
          files: [file],
        });
      } else {
        await navigator.share({
          title: options.title,
          text: options.text,
          url: LEAGUE_SHARE_SITE_URL,
        });
      }

      return {
        outcome: 'shared',
        message: options.sharedMessage,
      };
    } catch (error) {
      if (isShareCancellation(error)) {
        return {
          outcome: 'cancelled',
          message: '',
        };
      }

      // Some browsers advertise Web Share but reject file sharing at runtime.
      // The local PNG fallback keeps the member's action recoverable.
    }
  }

  triggerLeagueShareDownload(options.blob, options.filename);

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(options.text);
      return {
        outcome: 'downloaded',
        message: `${options.downloadedMessage} Its caption was copied.`,
      };
    } catch {
      // The image download already completed, so clipboard permission is optional.
    }
  }

  return {
    outcome: 'downloaded',
    message: options.downloadedMessage,
  };
}
