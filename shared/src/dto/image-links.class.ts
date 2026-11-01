/**
 * What a share link points at.
 *
 * `image` keeps the image embed templates (markdown image syntax, `<img>`);
 * `video` uses a plain link and a `<video>` element instead, because embedding
 * a video URL as a picture renders a broken image.
 */
export type ImageMediaKind = 'image' | 'video';

export class ImageLinks {
  source = '';
  markdown = '';
  html = '';
  rst = '';
  bbcode = '';
}
