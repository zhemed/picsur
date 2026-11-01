import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ImageEntryVariant } from 'picsur-shared/dist/dto/image-entry-variant.enum';
import {
    AsyncFailable,
    Fail,
    FT,
    HasFailed,
    IsFailure,
} from 'picsur-shared/dist/types/failable';
import { LessThan, Repository } from 'typeorm';
import { EImageDerivativeBackend } from '../../database/entities/images/image-derivative.entity.js';
import { EImageFileBackend } from '../../database/entities/images/image-file.entity.js';

const A_DAY_IN_SECONDS = 24 * 60 * 60;

/** Postgres unique violation (SQLSTATE 23505), as TypeORM surfaces it. */
function IsUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === '23505';
}

@Injectable()
export class ImageFileDBService {
  constructor(
    @InjectRepository(EImageFileBackend)
    private readonly imageFileRepo: Repository<EImageFileBackend>,

    @InjectRepository(EImageDerivativeBackend)
    private readonly imageDerivativeRepo: Repository<EImageDerivativeBackend>,
  ) {}

  public async setFile(
    imageId: string,
    variant: ImageEntryVariant,
    file: Buffer,
    filetype: string,
  ): AsyncFailable<true> {
    const imageFile = new EImageFileBackend();
    imageFile.image_id = imageId;
    imageFile.variant = variant;
    imageFile.filetype = filetype;
    imageFile.data = file;

    try {
      await this.imageFileRepo.upsert(imageFile, {
        conflictPaths: ['image_id', 'variant'],
      });
    } catch (e) {
      return Fail(FT.Database, e);
    }

    return true;
  }

  public async getFile(
    imageId: string,
    variant: ImageEntryVariant,
  ): AsyncFailable<EImageFileBackend> {
    try {
      const found = await this.imageFileRepo.findOne({
        where: { image_id: imageId ?? '', variant: variant ?? '' },
      });

      if (!found) return Fail(FT.NotFound, 'Image not found');
      return found;
    } catch (e) {
      return Fail(FT.Database, e);
    }
  }

  /**
   * File type and byte size of a stored file, without reading its data.
   *
   * `octet_length` is evaluated by Postgres, so HEAD requests can set
   * `Content-Length` for a 128 MB video without moving the bytes into Node.
   */
  public async getFileInfo(
    imageId: string,
    variant: ImageEntryVariant,
  ): AsyncFailable<{ filetype: string; size: number }> {
    try {
      const rows: { filetype: string; size: string | number }[] =
        await this.imageFileRepo.query(
          `SELECT filetype, octet_length(data) AS size
             FROM e_image_file_backend
            WHERE image_id = $1 AND variant = $2`,
          [imageId, variant],
        );

      if (rows.length === 0) return Fail(FT.NotFound, 'Image not found');
      return { filetype: rows[0].filetype, size: Number(rows[0].size) };
    } catch (e) {
      return Fail(FT.Database, e);
    }
  }

  /**
   * Reads one byte range of a stored file, without loading the whole file.
   *
   * `substr` runs in Postgres (the offsets are 1 based there, hence `offset+1`)
   * and `octet_length` comes back in the same round trip, so serving a 206 for
   * a 128 MB video moves only the requested slice through Node. The caller is
   * expected to have validated the range against `getFileInfo()` first.
   */
  public async getFileSlice(
    imageId: string,
    variant: ImageEntryVariant,
    offset: number,
    length: number,
  ): AsyncFailable<{ data: Buffer; size: number }> {
    try {
      const rows: { data: Buffer; size: string | number }[] =
        await this.imageFileRepo.query(
          `SELECT substr(data, $3, $4) AS data, octet_length(data) AS size
             FROM e_image_file_backend
            WHERE image_id = $1 AND variant = $2`,
          [imageId, variant, offset + 1, length],
        );

      if (rows.length === 0) return Fail(FT.NotFound, 'Image not found');
      return { data: rows[0].data, size: Number(rows[0].size) };
    } catch (e) {
      return Fail(FT.Database, e);
    }
  }

  public async migrateFile(
    imageId: string,
    sourceVariant: ImageEntryVariant,
    targetVariant: ImageEntryVariant,
  ): AsyncFailable<EImageFileBackend> {
    try {
      const sourceFile = await this.getFile(imageId, sourceVariant);
      if (HasFailed(sourceFile)) return sourceFile;

      sourceFile.variant = targetVariant;
      return await this.imageFileRepo.save(sourceFile);
    } catch (e) {
      return Fail(FT.Database, e);
    }
  }

  public async deleteFile(
    imageId: string,
    variant: ImageEntryVariant,
  ): AsyncFailable<EImageFileBackend> {
    try {
      const found = await this.imageFileRepo.findOne({
        where: { image_id: imageId, variant: variant },
      });

      if (!found) return Fail(FT.NotFound, 'Image not found');

      await this.imageFileRepo.delete({ image_id: imageId, variant: variant });
      return found;
    } catch (e) {
      return Fail(FT.Database, e);
    }
  }

  // This is useful because you dont have to pull the whole image file
  public async getFileTypes(
    imageId: string,
  ): AsyncFailable<{ [key in ImageEntryVariant]?: string }> {
    try {
      const found = await this.imageFileRepo.find({
        where: { image_id: imageId },
        select: ['variant', 'filetype'],
      });

      if (!found) return Fail(FT.NotFound, 'Image not found');

      const result: { [key in ImageEntryVariant]?: string } = {};
      for (const file of found) {
        result[file.variant] = file.filetype;
      }

      return result;
    } catch (e) {
      return Fail(FT.Database, e);
    }
  }

  public async addDerivative(
    imageId: string,
    key: string,
    filetype: string,
    file: Buffer,
  ): AsyncFailable<EImageDerivativeBackend> {
    const imageDerivative = new EImageDerivativeBackend();
    imageDerivative.image_id = imageId;
    imageDerivative.key = key;
    imageDerivative.filetype = filetype;
    imageDerivative.data = file;
    imageDerivative.last_read = new Date();

    try {
      return await this.imageDerivativeRepo.save(imageDerivative);
    } catch (e) {
      // Two requests can miss the same cached conversion at the same time (the
      // "look up, then lock" sequence in `MutexFallBack` is not atomic). The
      // loser used to answer 500 on the unique constraint; the conversion it
      // wanted is already there, so return that instead.
      if (IsUniqueViolation(e)) {
        const existing = await this.getDerivative(imageId, key);
        if (!IsFailure(existing) && existing !== null) return existing;
      }

      return Fail(FT.Database, e);
    }
  }

  // Returns null when derivative is not found
  public async getDerivative(
    imageId: string,
    key: string,
  ): AsyncFailable<EImageDerivativeBackend | null> {
    try {
      const derivative = await this.imageDerivativeRepo.findOne({
        where: { image_id: imageId, key },
      });
      if (!derivative) return null;

      // Touch `last_read` at most once a day: writing on *every* read put a
      // database write on the image hot path, while a derivative that had not
      // been read for a day was never refreshed at all and got deleted by the
      // cleanup cron while still in use (audit A-7).
      const yesterday = new Date(Date.now() - A_DAY_IN_SECONDS * 1000);
      if (derivative.last_read < yesterday) {
        derivative.last_read = new Date();
        return await this.imageDerivativeRepo.save(derivative);
      }

      return derivative;
    } catch (e) {
      return Fail(FT.Database, e);
    }
  }

  public async countDerivatives(imageId: string): AsyncFailable<number> {
    try {
      return await this.imageDerivativeRepo.count({
        where: { image_id: imageId },
      });
    } catch (e) {
      return Fail(FT.Database, e);
    }
  }

  public async cleanupDerivatives(
    olderThanSeconds: number,
  ): AsyncFailable<number> {
    try {
      const result = await this.imageDerivativeRepo.delete({
        last_read: LessThan(new Date(Date.now() - olderThanSeconds * 1000)),
      });

      return result.affected ?? 0;
    } catch (e) {
      return Fail(FT.Database, e);
    }
  }
}
