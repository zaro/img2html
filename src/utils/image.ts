import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ImageScalerOptions {
  maxWidth?: number;
  maxHeight?: number;
}

async function scaleImageBuffer(buffer: Buffer, options: ImageScalerOptions): Promise<Buffer> {
  const { maxWidth, maxHeight } = options;

  if (!maxWidth && !maxHeight) {
    return buffer;
  }

  const metadata = await sharp(buffer).metadata();

  if (!metadata.width || !metadata.height) {
    return buffer;
  }

  let targetWidth = maxWidth;
  let targetHeight = maxHeight;

  if (targetWidth && targetHeight) {
    const widthRatio = targetWidth / metadata.width;
    const heightRatio = targetHeight / metadata.height;
    const ratio = Math.min(widthRatio, heightRatio);

    if (ratio >= 1) {
      return buffer;
    }

    targetWidth = Math.round(metadata.width * ratio);
    targetHeight = Math.round(metadata.height * ratio);
  } else if (targetWidth) {
    if (targetWidth >= metadata.width) {
      return buffer;
    }
    targetHeight = Math.round(metadata.height * (targetWidth / metadata.width));
  } else if (targetHeight) {
    if (targetHeight >= metadata.height) {
      return buffer;
    }
    targetWidth = Math.round(metadata.width * (targetHeight / metadata.height));
  }

  const scaledBuffer = await sharp(buffer)
    .resize(targetWidth, targetHeight, { fit: "inside" })
    .toBuffer();

  return Buffer.from(new Uint8Array(scaledBuffer));
}

export async function loadImageAsDataUrl(
  imagePath: string,
  scalerOptions?: ImageScalerOptions
): Promise<string> {
  if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
    const response = await fetch(imagePath);
    if (!response.ok) {
      throw new Error(`Failed to fetch image from URL: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    let buffer: Buffer = Buffer.from(arrayBuffer);

    if (scalerOptions) {
      buffer = await scaleImageBuffer(buffer, scalerOptions);
    }

    const mimeType = response.headers.get("content-type") || "image/png";
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  }

  const resolvedPath = path.resolve(imagePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Image file not found: ${resolvedPath}`);
  }

  let buffer: Buffer = fs.readFileSync(resolvedPath);

  if (scalerOptions) {
    buffer = await scaleImageBuffer(buffer, scalerOptions);
  }

  const ext = path.extname(resolvedPath).toLowerCase();

  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };

  const mimeType = mimeTypes[ext] || "image/png";
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}