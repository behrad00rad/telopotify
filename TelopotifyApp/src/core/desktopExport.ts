export type ExportTrack = {
  id: string;
  messageId: number;
  title: string;
  artist: string;
  fileName: string | null;
  fileSize: number | null;
  durationSeconds: number | null;
  mimeType: string | null;
};

type ExportMessage = {
  id?: unknown;
  type?: unknown;
  media_type?: unknown;
  file_name?: unknown;
  file_size?: unknown;
  title?: unknown;
  performer?: unknown;
  mime_type?: unknown;
  duration_seconds?: unknown;
};

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function parseDesktopExport(data: unknown): ExportTrack[] {
  if (!data || typeof data !== 'object' || !('messages' in data) ||
      !Array.isArray(data.messages)) {
    throw new Error('Expected a Telegram Desktop chat export with a messages array');
  }

  const tracks: ExportTrack[] = [];
  for (const raw of data.messages) {
    if (!raw || typeof raw !== 'object') continue;
    const message = raw as ExportMessage;
    const messageId = number(message.id);
    if (!messageId || message.type !== 'message' || message.media_type !== 'audio_file') continue;

    const fileName = text(message.file_name) || null;
    const title = text(message.title) || fileName?.replace(/\.[^.]+$/, '') || `Track ${messageId}`;
    tracks.push({
      id: String(messageId),
      messageId,
      title,
      artist: text(message.performer) || 'Unknown artist',
      fileName,
      fileSize: number(message.file_size),
      durationSeconds: number(message.duration_seconds),
      mimeType: text(message.mime_type) || null,
    });
  }
  return tracks;
}
