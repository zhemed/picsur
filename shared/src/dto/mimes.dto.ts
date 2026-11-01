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
 * The upload and direct-link path never transcodes: the stored master is the
 * uploaded bytes and the direct link serves it back in the same container.
 * Accepting a container therefore means "we can store it and hand it back";
 * whether the browser can *play* it is a separate question, answered by
 * `PlayableVideoFileTypes` plus a runtime `canPlayType` probe on the client.
 *
 * Every entry here must be a container `file-type` recognises by magic bytes;
 * the MIME on the right of `FileType2MimeMap` is exactly what `file-type`
 * reports (they are not always the vendor mime, e.g. Matroska reports
 * `video/matroska`, AVI reports `video/vnd.avi`).
 */
export enum VideoFileType {
  MP4 = 'video:mp4',
  WEBM = 'video:webm',
  MOV = 'video:mov',
  MKV = 'video:mkv',
  AVI = 'video:avi',
  WMV = 'video:wmv',
  FLV = 'video:flv',
  TS = 'video:ts',
  M3GP = 'video:3gp',
  OGV = 'video:ogv',
  M4V = 'video:m4v',
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

/**
 * Video containers that play natively in every browser this project targets.
 *
 * These are the only ones the detail page can render a player for without
 * asking. Every other accepted container is stored and downloadable, but the
 * page has to probe `HTMLVideoElement.canPlayType(mime)` first: support varies
 * by browser and by codec inside the container.
 */
export const PlayableVideoFileTypes: string[] = [
  VideoFileType.MP4,
  VideoFileType.WEBM,
];

/** Whether the identifier is one of the universally native-playable videos. */
export const IsPlayableVideoFiletype = (
  filetype: string | null | undefined,
): boolean =>
  typeof filetype === 'string' && PlayableVideoFileTypes.includes(filetype);

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
  [VideoFileType.MOV]: 'video/quicktime',
  // file-type reports Matroska as `video/matroska` (not the x- vendor mime).
  [VideoFileType.MKV]: 'video/matroska',
  [VideoFileType.AVI]: 'video/vnd.avi',
  [VideoFileType.WMV]: 'video/x-ms-asf',
  [VideoFileType.FLV]: 'video/x-flv',
  [VideoFileType.TS]: 'video/mp2t',
  [VideoFileType.M3GP]: 'video/3gpp',
  [VideoFileType.OGV]: 'video/ogg',
  [VideoFileType.M4V]: 'video/x-m4v',
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
  [VideoFileType.MOV]: 'mov',
  [VideoFileType.MKV]: 'mkv',
  [VideoFileType.AVI]: 'avi',
  [VideoFileType.WMV]: 'wmv',
  [VideoFileType.FLV]: 'flv',
  [VideoFileType.TS]: 'ts',
  [VideoFileType.M3GP]: '3gp',
  [VideoFileType.OGV]: 'ogv',
  [VideoFileType.M4V]: 'm4v',
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
