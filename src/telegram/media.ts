import type TelegramBot from "node-telegram-bot-api";
import type { AgentImageInput } from "../agent/image-input";

export const MAX_TELEGRAM_IMAGE_BYTES = 10 * 1024 * 1024;

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  width: number;
  height: number;
}

export interface TelegramImageDocument {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramImageMessage {
  photo?: TelegramPhotoSize[];
  document?: TelegramImageDocument;
}

interface SelectedTelegramImage {
  file_id: string;
  file_size?: number;
}

export class TelegramImageError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
    this.name = "TelegramImageError";
  }
}

const SUPPORTED_DOCUMENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function selectTelegramImage(
  message: TelegramImageMessage
): SelectedTelegramImage | null {
  if (message.photo?.length) {
    const photo = message.photo.reduce((largest, candidate) => {
      const largestArea = largest.width * largest.height;
      const candidateArea = candidate.width * candidate.height;
      return candidateArea >= largestArea ? candidate : largest;
    });
    if ((photo.file_size ?? 0) > MAX_TELEGRAM_IMAGE_BYTES) {
      throw new TelegramImageError("That image is over 10 MB. Please send a smaller copy.");
    }
    return { file_id: photo.file_id, file_size: photo.file_size };
  }

  if (message.document) {
    if (!SUPPORTED_DOCUMENT_TYPES.has(message.document.mime_type ?? "")) {
      throw new TelegramImageError(
        "Please send the image as a photo, PNG, JPEG, or WebP file."
      );
    }
    if ((message.document.file_size ?? 0) > MAX_TELEGRAM_IMAGE_BYTES) {
      throw new TelegramImageError("That image is over 10 MB. Please send a smaller copy.");
    }
    return {
      file_id: message.document.file_id,
      file_size: message.document.file_size,
    };
  }

  return null;
}

function detectImageMimeType(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export async function loadTelegramImage(
  bot: Pick<TelegramBot, "getFileStream">,
  message: TelegramImageMessage
): Promise<AgentImageInput[]> {
  const selected = selectTelegramImage(message);
  if (!selected) return [];

  const stream = bot.getFileStream(selected.file_id);
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > MAX_TELEGRAM_IMAGE_BYTES) {
        stream.destroy();
        throw new TelegramImageError("That image is over 10 MB. Please send a smaller copy.");
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof TelegramImageError) throw error;
    throw new TelegramImageError("I couldn't download that image. Please send it again.");
  }

  const bytes = Buffer.concat(chunks);
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) {
    throw new TelegramImageError("I couldn't verify that image. Please resend it as PNG or JPEG.");
  }

  return [{ data_url: `data:${mimeType};base64,${bytes.toString("base64")}` }];
}
