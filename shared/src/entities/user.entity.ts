import { z } from 'zod';
import { IsEntityID } from '../validators/entity-id.validator.js';
import { IsStringList } from '../validators/string-list.validator.js';
import { IsPlainTextPwd, IsUsername } from '../validators/user.validators.js';

export const SimpleUserSchema = z.object({
  username: IsUsername(),
  password: IsPlainTextPwd(),
  /** Optional: new accounts start with no permissions (default deny). */
  permissions: IsStringList().optional(),
});
export type SimpleUser = z.infer<typeof SimpleUserSchema>;

export const EUserSchema = z.object({
  id: IsEntityID(),
  username: IsUsername(),
  /**
   * Permissions granted to this account directly. Implicit permissions (login,
   * keep-login, settings) and the full set of the reserved `admin` account are
   * added at check time and are not necessarily part of this list.
   */
  permissions: IsStringList(),
  /**
   * Never serialised: the property must be absent (or `undefined`) on API
   * objects. Zod 4 requires the key to be present when the schema itself
   * accepts `undefined`, and JSON drops `undefined` values, so this has to be
   * explicitly optional or every response carrying a user would fail its own
   * response validation.
   */
  hashedPassword: z.undefined().optional(),
});
export type EUser = z.infer<typeof EUserSchema>;
