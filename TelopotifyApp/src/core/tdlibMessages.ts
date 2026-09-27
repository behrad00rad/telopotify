import { trackFromAudio, type Track } from './library.ts';

type TdFile = { id: number; size: number; expected_size?: number };
type TdAudio = {
  title?: string;
  performer?: string;
  file_name?: string;
  duration?: number;
  mime_type?: string;
  audio: TdFile;
};
type TdDocument = {
  file_name?: string;
  mime_type?: string;
  document: TdFile;
};

export type TdMessage = {
  id: number;
  chat_id: number;
  content:
    | { '@type': 'messageAudio'; audio: TdAudio }
    | { '@type': 'messageDocument'; document: TdDocument }
    | { '@type': string; [key: string]: unknown };
};

const audioExtensions = /\.(mp3|m4a|aac|ogg|opus|flac|wav)$/i;
const audioMimes = new Set([
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg',
  'audio/opus', 'audio/flac', 'audio/wav', 'audio/x-wav',
]);

export function trackFromTdMessage(message: TdMessage): Track | null {
  if (message.content['@type'] === 'messageAudio') {
    const audio = message.content.audio as TdAudio;
    if (!audio?.audio) return null;
    return trackFromAudio({
      channelId: String(message.chat_id),
      messageId: message.id,
      fileId: audio.audio.id,
      fileSize: audio.audio.size,
      title: audio.title,
      artist: audio.performer,
      fileName: audio.file_name,
      durationSeconds: audio.duration,
      mimeType: audio.mime_type,
    });
  }

  if (message.content['@type'] === 'messageDocument') {
    const document = message.content.document as TdDocument;
    if (!document?.document) return null;
    const mime = (document.mime_type ?? '').toLowerCase();
    if (!audioMimes.has(mime) && !audioExtensions.test(document.file_name ?? '')) return null;
    return trackFromAudio({
      channelId: String(message.chat_id),
      messageId: message.id,
      fileId: document.document.id,
      fileSize: document.document.size,
      fileName: document.file_name,
      mimeType: document.mime_type,
    });
  }

  return null;
}
