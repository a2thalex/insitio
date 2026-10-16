import type { User } from "../services/users.js";

export type Env = {
  Variables: {
    user: User | null;
    session: { id: string; csrf: string } | null;
    /** The CSRF token forms on this request must echo back. */
    csrf: string;
  };
};
