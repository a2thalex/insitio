import type { User } from "../services/users.js";

export type Env = {
  Variables: {
    user: User | null;
    session: { id: string; csrf: string } | null;
    /** The CSRF token forms on this request must echo back. */
    csrf: string;
    /** Unread inbox rows for the signed-in user. Anonymous requests stay at 0. */
    unread: number;
  };
};
