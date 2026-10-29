import * as z from 'zod';

const ApiResponseBase = z.object({
  statusCode: z.number().min(0).max(600).int(),
  timestamp: z.string(),
  timeMs: z.number().min(0).int(),
});

const ApiSuccessResponse = <T extends z.ZodObject>(data: T) =>
  ApiResponseBase.merge(
    z.object({
      success: z.literal(true),
      data,
    }),
  );

const ApiErrorResponseSchema = ApiResponseBase.merge(
  z.object({
    success: z.literal(false),
    data: z.object({
      type: z.string(),
      message: z.string(),
    }),
  }),
);

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

/**
 * Wire shape of a successful envelope.
 *
 * Zod 4 cannot infer a resolvable object type for a schema that embeds a
 * generic schema (`.merge()` with a generic `data` yields an unresolved mapped
 * type), which breaks `success === false` narrowing on the client. The runtime
 * schema below is unchanged; only its static type is pinned to this explicit
 * envelope so the union stays discriminated.
 */
export type ApiSuccessEnvelope<T> = Omit<
  ApiErrorResponse,
  'success' | 'data'
> & {
  success: true;
  data: T;
};

export type ApiResponseEnvelope<T> =
  | ApiErrorResponse
  | ApiSuccessEnvelope<T>;

export const ApiResponseSchema = <T extends z.ZodObject>(
  data: T,
): z.ZodType<ApiResponseEnvelope<z.infer<T>>> =>
  ApiErrorResponseSchema.or(
    ApiSuccessResponse(data),
  ) as unknown as z.ZodType<ApiResponseEnvelope<z.infer<T>>>;

const _ApiAnySuccessResponseSchema = ApiSuccessResponse(z.object({}))
  .omit({ data: true })
  .merge(
    z.object({
      data: z.any(),
    }),
  );
export type ApiAnySuccessResponse = z.infer<
  typeof _ApiAnySuccessResponseSchema
>;
