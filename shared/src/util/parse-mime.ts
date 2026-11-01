import {
  Ext2FileType,
  FileType,
  Mime2FileType,
  SupportedAnimFileTypes,
  SupportedFileTypeCategory,
  SupportedImageFileTypes,
  SupportedVideoFileTypes,
} from '../dto/mimes.dto.js';
import { Fail, Failable, FT, HasFailed } from '../types/failable.js';

/**
 * Whether a filetype identifier belongs to the video category.
 *
 * Video is detected with this single check instead of a database column: the
 * stored `source_filetype` already is `video:<container>` for an uploaded
 * video, and every list row carries it. Keeping the prefix check in one place
 * means a future explicit media column only has to be handled here.
 */
export function IsVideoFiletypeIdentifier(
  identifier: string | null | undefined,
): boolean {
  return typeof identifier === 'string' && identifier.startsWith('video:');
}

export function ParseFileType(filetype: string): Failable<FileType> {
  if (SupportedImageFileTypes.includes(filetype))
    return { identifier: filetype, category: SupportedFileTypeCategory.Image };

  if (SupportedAnimFileTypes.includes(filetype))
    return {
      identifier: filetype,
      category: SupportedFileTypeCategory.Animation,
    };

  if (SupportedVideoFileTypes.includes(filetype))
    return {
      identifier: filetype,
      category: SupportedFileTypeCategory.Video,
    };

  return Fail(FT.UsrValidation, 'Unsupported file type');
}

export function ParseExt2FileType(ext: string): Failable<FileType> {
  const result = Ext2FileType(ext);
  if (HasFailed(result)) return result;
  return ParseFileType(result);
}

export function ParseMime2FileType(mime: string): Failable<FileType> {
  const result = Mime2FileType(mime);
  if (HasFailed(result)) return result;
  return ParseFileType(result);
}
