import { Injectable } from '@angular/core';
import { I18nService } from '../../i18n/i18n.service';

import {
  ImageDeleteRequest,
  ImageDeleteResponse,
  ImageListAllRequest,
  ImageListAllResponse,
  ImageListRequest,
  ImageListResponse,
  ImageUpdateRequest,
  ImageUpdateResponse,
  ImageUploadResponse,
} from 'picsur-shared/dist/dto/api/image-manage.dto';
import {
  ImageMetaResponse,
  ImageRequestParams,
} from 'picsur-shared/dist/dto/api/image.dto';
import {
  ImageLinks,
  ImageMediaKind,
} from 'picsur-shared/dist/dto/image-links.class';
import { FileType2Ext } from 'picsur-shared/dist/dto/mimes.dto';
import { EImage } from 'picsur-shared/dist/entities/image.entity';
import { AsyncFailable } from 'picsur-shared/dist/types/failable';
import {
  FT,
  Fail,
  HasFailed,
  HasSuccess,
  Open,
} from 'picsur-shared/dist/types/failable';
import { ImageUploadRequest } from '../../models/dto/image-upload-request.dto';
import { ApiService } from './api.service';
import { InfoService } from './info.service';
import { UserService } from './user.service';

@Injectable({
  providedIn: 'root',
})
export class ImageService {
  constructor(
    private readonly api: ApiService,
    private readonly infoService: InfoService,
    private readonly userService: UserService,
    private readonly i18n: I18nService,
  ) {}

  public async UploadImage(image: File): AsyncFailable<string> {
    const result = await this.api.postForm(
      ImageUploadResponse,
      '/api/image/upload',
      new ImageUploadRequest(image),
    ).result;

    return Open(result, 'id');
  }

  // public async UploadImages(images: File[]): AsyncFailable<string[]> {
  //   console.log('Uploading images', images);

  //   // Split into chunks of 20
  //   const groups = this.chunks(images, 20);

  //   const result = await this.api.postForm(
  //     ImageUploadResponse,
  //     '/api/image/upload/bulk',
  //     new ImagesUploadRequest(images),
  //   );

  //   return [];
  // }

  public async GetImageMeta(image: string): AsyncFailable<ImageMetaResponse> {
    return await this.api.get(ImageMetaResponse, `/i/meta/${image}`).result;
  }

  public async ListAllImages(
    count: number,
    page: number,
    userID?: string,
  ): AsyncFailable<ImageListResponse> {
    return await this.api.post(
      ImageListRequest,
      ImageListResponse,
      '/api/image/list',
      {
        count,
        page,
        user_id: userID,
      },
    ).result;
  }

  public async ListAllImagesUnpaged(
    userID?: string,
  ): AsyncFailable<ImageListAllResponse> {
    return await this.api.post(
      ImageListAllRequest,
      ImageListAllResponse,
      '/api/image/list/all',
      {
        user_id: userID,
      },
    ).result;
  }

  public async ListMyImages(
    count: number,
    page: number,
  ): AsyncFailable<ImageListResponse> {
    const userID = await this.userService.snapshot?.id;
    if (userID === undefined) {
      return Fail(FT.Authentication, 'auth.notLoggedIn');
    }

    return await this.ListAllImages(count, page, userID);
  }

  public async ListAllMyImagesUnpaged(): AsyncFailable<ImageListAllResponse> {
    const userID = await this.userService.snapshot?.id;
    if (userID === undefined) {
      return Fail(FT.Authentication, 'auth.notLoggedIn');
    }

    return await this.ListAllImagesUnpaged(userID);
  }

  public async UpdateImage(
    id: string,
    settings: Partial<Pick<EImage, 'file_name' | 'expires_at'>>,
  ): AsyncFailable<EImage> {
    return await this.api.post(
      ImageUpdateRequest,
      ImageUpdateResponse,
      '/api/image/update',
      {
        id,
        ...settings,
      },
    ).result;
  }

  public async DeleteImages(
    images: string[],
  ): AsyncFailable<ImageDeleteResponse> {
    return await this.api.post(
      ImageDeleteRequest,
      ImageDeleteResponse,
      '/api/image/delete',
      {
        ids: images,
      },
    ).result;
  }

  public async DeleteImage(image: string): AsyncFailable<EImage> {
    const result = await this.DeleteImages([image]);
    if (HasFailed(result)) return result;

    if (result.images.length !== 1) {
      return Fail(FT.Unknown, 'images.deleteFailedPermission');
    }

    return result.images[0];
  }

  // Non api calls

  // Use for native images
  public GetImageURL(
    image: string,
    filetype: string | null,
    allowOverride = false,
  ): string {
    const baseURL = this.infoService.getHostname(allowOverride);
    const extension = FileType2Ext(filetype ?? '');

    return `${baseURL}/i/${image}${
      HasSuccess(extension) ? '.' + extension : ''
    }`;
  }

  // Use for user facing urls
  public CreateImageLinks(
    imageURL: string,
    name?: string,
    kind: ImageMediaKind = 'image',
  ): ImageLinks {
    const fallbackName = this.i18n.instant('images.defaultAlt');
    const alt = name ?? fallbackName;

    // A video is not a picture: an image embed of its URL shows a broken
    // picture, so markdown gets a normal link and HTML a <video> element.
    if (kind === 'video') {
      return {
        source: imageURL,
        markdown: `[${this.escapeMarkdown(alt)}](${imageURL})`,
        html: `<video controls playsinline src="${imageURL}"></video>`,
        rst: imageURL,
        bbcode: `[url]${imageURL}[/url]`,
      };
    }

    // The file name is user input, so it must not be able to break out of the
    // snippets that are offered for copy & paste.
    return {
      source: imageURL,
      markdown: `![${this.escapeMarkdown(alt)}](${imageURL})`,
      html: `<img src="${imageURL}" alt="${this.escapeHTML(alt)}">`,
      rst: `.. image:: ${imageURL}`,
      bbcode: `[img]${imageURL}[/img]`,
    };
  }

  private escapeHTML(text: string): string {
    return text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  private escapeMarkdown(text: string): string {
    return text.replaceAll('[', '').replaceAll(']', '');
  }

  public GetImageURLCustomized(
    image: string,
    filetype: string | null,
    options: ImageRequestParams,
  ): string {
    const baseURL = this.GetImageURL(image, filetype, true);
    const betterOptions = ImageRequestParams.zodSchema.safeParse(options);

    if (!betterOptions.success) return baseURL;

    const queryParams: string[] = [];

    if (options.height !== undefined)
      queryParams.push(`height=${options.height}`);
    if (options.width !== undefined) queryParams.push(`width=${options.width}`);
    if (options.rotate !== undefined)
      queryParams.push(`rotate=${options.rotate}`);
    if (options.flipx !== undefined) queryParams.push(`flipx=${options.flipx}`);
    if (options.flipy !== undefined) queryParams.push(`flipy=${options.flipy}`);
    if (options.shrinkonly !== undefined)
      queryParams.push(`shrinkonly=${options.shrinkonly}`);
    if (options.greyscale !== undefined)
      queryParams.push(`greyscale=${options.greyscale}`);
    if (options.noalpha !== undefined)
      queryParams.push(`noalpha=${options.noalpha}`);
    if (options.negative !== undefined)
      queryParams.push(`negative=${options.negative}`);
    if (options.quality !== undefined)
      queryParams.push(`quality=${options.quality}`);

    if (queryParams.length === 0) return baseURL;

    return baseURL + '?' + queryParams.join('&');
  }

  public CreateImageLinksFromID(
    imageID: string,
    mime: string | null,
    name?: string,
    kind: ImageMediaKind = 'image',
  ): ImageLinks {
    return this.CreateImageLinks(
      this.GetImageURL(imageID, mime, true),
      name,
      kind,
    );
  }

  private chunks<T>(arr: T[], size: number): T[][] {
    const result = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, size + i));
    }

    return result;
  }
}
