import { Fail, Failable, FT } from '../types/failable.js';

// Config
export enum ImageFileType {
  QOI = 'image:qoi',
  JPEG = 'image:jpeg',
  PNG = 'image:png',
  WEBP = 'image:webp',
  SVG = 'image:svg',
  TIFF = 'image:tiff',
  AVIF = 'image:avif',
  HEIF = 'image:heif',
  JXL = 'image:jxl',
  JP2 = 'image:jp2',
  BMP = 'image:bmp',
  // ICO = 'image:ico',
}

export enum AnimFileType {
  GIF = 'anim:gif',
  WEBP = 'anim:webp',
  //APNG = 'anim:apng',
}

/**
 * Video containers the instance accepts.
 *
 * Only formats a browser can play natively are listed: the upload and direct
 * link path (tier A) does not transcode, so anything else would be stored but
 * could not be played. Other video containers (mov, mkv, avi, ...) are
 * recognised by `file-type` and then rejected as a user validation error.
 */
export enum VideoFileType {
  MP4 = 'video:mp4',
  WEBM = 'video:webm',
}

// Derivatives

export const SupportedImageFileTypes: string[] = Object.values(ImageFileType);
export const SupportedAnimFileTypes: string[] = Object.values(AnimFileType);
export const SupportedVideoFileTypes: string[] = Object.values(VideoFileType);
export const SupportedFileTypes: string[] = Object.values({
  ...ImageFileType,
  ...AnimFileType,
  ...VideoFileType,
});

export enum SupportedFileTypeCategory {
  Image = 'image',
  Animation = 'anim',
  Video = 'video',
}

export interface FileType {
  identifier: string;
  category: SupportedFileTypeCategory;
}

// Converters

// -- Mime

const FileType2MimeMap: {
  [key in ImageFileType | AnimFileType | VideoFileType]: string;
} = {
  [AnimFileType.GIF]: 'image/gif',
  [AnimFileType.WEBP]: 'image/webp',
  // [AnimFileType.APNG]: 'image/apng',
  [ImageFileType.QOI]: 'image/x-qoi',
  [ImageFileType.JPEG]: 'image/jpeg',
  [ImageFileType.PNG]: 'image/png',
  [ImageFileType.WEBP]: 'image/webp', // Image webp comes later, so will be default
  [ImageFileType.SVG]: 'image/svg+xml',
  [ImageFileType.TIFF]: 'image/tiff',
  [ImageFileType.AVIF]: 'image/avif',
  [ImageFileType.HEIF]: 'image/heic',
  [ImageFileType.JXL]: 'image/jxl',
  [ImageFileType.JP2]: 'image/jp2',
  [ImageFileType.BMP]: 'image/bmp',
  // [ImageFileType.ICO]: 'image/x-icon',
  [VideoFileType.MP4]: 'video/mp4',
  [VideoFileType.WEBM]: 'video/webm',
};

export const Mime2FileType = (mime: string): Failable<string> => {
  const entries = Object.entries(FileType2MimeMap).filter(
    ([, v]) => v === mime,
  );
  if (entries.length === 0)
    return Fail(FT.Internal, undefined, `Unsupported mime type: ${mime}`);
  return entries[0][0];
};
export const FileType2Mime = (filetype: string): Failable<string> => {
  const result =
    FileType2MimeMap[filetype as ImageFileType | AnimFileType | VideoFileType];
  if (result === undefined)
    return Fail(FT.Internal, undefined, `Unsupported filetype: ${filetype}`);
  return result;
};

// -- Ext

const FileType2ExtMap: {
  [key in ImageFileType | AnimFileType | VideoFileType]: string;
} = {
  [AnimFileType.GIF]: 'gif',
  [AnimFileType.WEBP]: 'webp',
  // [AnimFileType.APNG]: 'apng',
  [ImageFileType.QOI]: 'qoi',
  [ImageFileType.JPEG]: 'jpg',
  [ImageFileType.PNG]: 'png',
  [ImageFileType.WEBP]: 'webp',
  [ImageFileType.SVG]: 'svg',
  [ImageFileType.TIFF]: 'tiff',
  [ImageFileType.AVIF]: 'avif',
  [ImageFileType.HEIF]: 'heif',
  [ImageFileType.JXL]: 'jxl',
  [ImageFileType.JP2]: 'jp2',
  [ImageFileType.BMP]: 'bmp',
  // [ImageFileType.ICO]: 'ico',
  [VideoFileType.MP4]: 'mp4',
  [VideoFileType.WEBM]: 'webm',
};

export const Ext2FileType = (ext: string): Failable<string> => {
  const entries = Object.entries(FileType2ExtMap).filter(([, v]) => v === ext);
  if (entries.length === 0)
    return Fail(FT.Internal, undefined, `Unsupported ext: ${ext}`);
  return entries[0][0];
};

export const FileType2Ext = (mime: string): Failable<string> => {
  const result =
    FileType2ExtMap[mime as ImageFileType | AnimFileType | VideoFileType];
  if (result === undefined)
    return Fail(FT.Internal, undefined, `Unsupported mime type: ${mime}`);
  return result;
};
