import { afterEach, describe, expect, it, vi } from "vitest";

// requireSuperAdmin() checks profiles.is_super_admin (migration 044) —
// orthogonal to account_role/getCurrentAccount entirely.

function makeClient(opts: {
  user: { id: string } | null;
  userErr?: unknown;
  profile?: { data: unknown; error: unknown };
}) {
  const from = (table: string) => {
    const builder = {
      select() {
        return builder;
      },
      eq() {
        return builder;
      },
      maybeSingle() {
        if (table !== "profiles") return Promise.resolve({ data: null, error: null });
        return Promise.resolve(opts.profile ?? { data: null, error: null });
      },
    };
    return builder;
  };

  return {
    auth: {
      getUser: () =>
        Promise.resolve({
          data: { user: opts.user },
          error: opts.userErr ?? null,
        }),
    },
    from,
  };
}

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => createClient(),
}));

const { requireSuperAdmin } = await import("./super-admin");
const { UnauthorizedError, ForbiddenError } = await import("./account");

afterEach(() => {
  vi.clearAllMocks();
});

describe("requireSuperAdmin", () => {
  it("resolves when the caller's profile has is_super_admin = true", async () => {
    createClient.mockReturnValue(
      makeClient({
        user: { id: "user-1" },
        profile: { data: { is_super_admin: true }, error: null },
      }),
    );

    const ctx = await requireSuperAdmin();
    expect(ctx.userId).toBe("user-1");
  });

  it("throws UnauthorizedError when there is no session", async () => {
    createClient.mockReturnValue(makeClient({ user: null }));
    await expect(requireSuperAdmin()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("throws ForbiddenError when is_super_admin is false", async () => {
    createClient.mockReturnValue(
      makeClient({
        user: { id: "user-1" },
        profile: { data: { is_super_admin: false }, error: null },
      }),
    );
    await expect(requireSuperAdmin()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("throws ForbiddenError when the profile row is missing", async () => {
    createClient.mockReturnValue(
      makeClient({
        user: { id: "user-1" },
        profile: { data: null, error: null },
      }),
    );
    await expect(requireSuperAdmin()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("throws ForbiddenError when the profile lookup errors", async () => {
    createClient.mockReturnValue(
      makeClient({
        user: { id: "user-1" },
        profile: { data: null, error: { code: "PGRST200" } },
      }),
    );
    await expect(requireSuperAdmin()).rejects.toBeInstanceOf(ForbiddenError);
  });
});
