"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { AltokiaLogo } from "@/components/brand/altokia-logo";
import {
  ALTOKIA_SURFACE_STYLE,
  altokiaSurfaceCss,
} from "@/components/brand/altokia-theme";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";

// This screen belongs to Altokia, not to the client: it is the first
// thing a customer sees, before there is a workspace to have a theme
// at all. So it pins the brand palette the same way the /platform
// console does, rather than inheriting whatever accent and light/dark
// mode the last signed-in person left in localStorage — a sign-in page
// that changes color depending on who used the browser last is not a
// front door. `AUTH_CSS` carries the same tokens to anything that
// renders outside this subtree (toasts).
const AUTH_CSS = altokiaSurfaceCss("auth");

// `useSearchParams` opts the component out of static prerendering
// unless it sits under a Suspense boundary. We split the form into
// a child component so the outer page can prerender the chrome
// (background, card frame) while the form hydrates with the query
// string on the client.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

/**
 * Did this sign-in fail because the user is banned, rather than because
 * the password is wrong?
 *
 * The two are genuinely distinguishable: GoTrue answers a password grant
 * from a banned user with the `user_banned` error code, and `AuthError`
 * carries it on `.code` (auth-js exposes it in its `ErrorCode` union).
 * Wrong credentials come back as `invalid_credentials`. We match on the
 * code and nothing else — no HTTP status, no message substring — so a
 * copy edit upstream cannot start telling people their access was
 * revoked when they merely typoed their password.
 *
 * Enforcement lives on the auth user itself (migration 050); this is
 * only the difference between a useful message and a wrong one.
 */
function isBannedError(error: { code?: string }): boolean {
  return error.code === "user_banned";
}

function LoginPageInner() {
  const searchParams = useSearchParams();
  // Forwarded from `/join/<token>` when the visitor already has an
  // account. After a successful sign-in we send them to the join
  // page to accept rather than to /dashboard.
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("LoginPage");
  const tAuth = useTranslations("Auth");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Told apart from `error` because it is not the user's mistake and no
  // amount of retrying fixes it: Altokia pulled this login's access.
  const [revoked, setRevoked] = useState(false);
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setRevoked(false);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      if (isBannedError(error)) setRevoked(true);
      else setError(error.message);
      setLoading(false);
      return;
    }

    // Full-page navigation (not router.push) so the browser issues a
    // fresh top-level request that carries the just-written Supabase
    // auth cookies to the middleware gating /dashboard. A soft
    // client-side navigation can reach the protected route before the
    // server observes the new session, so the middleware bounces it
    // back to /login — which looks like the page "just refreshing"
    // instead of signing in (issue #365). Mirrors the deliberate full
    // reload the invite-accept flow already uses in join/[token].
    const destination = inviteToken
      ? `/join/${encodeURIComponent(inviteToken)}`
      : "/dashboard";
    window.location.href = destination;
  };

  return (
    <div
      data-plane="auth"
      style={ALTOKIA_SURFACE_STYLE}
      className="flex min-h-screen items-center justify-center bg-background px-4"
    >
      <style dangerouslySetInnerHTML={{ __html: AUTH_CSS }} />
      <Card className="w-full max-w-md bg-card">
        {/* The one brand gesture on this screen: a hairline seal on the
            card's top edge. The negative margin cancels the card's own
            top padding so it sits flush; the card already clips its
            corners. Everything else stays sober — this is a door, not
            a cover page. */}
        <div
          aria-hidden="true"
          className="-mt-4 h-0.5 w-full"
          style={{ backgroundImage: "var(--altokia-gradient)" }}
        />
        <CardHeader className="items-center text-center">
          {/* The wordmark replaces the greeting. The description below
              still says which of the two arrivals this is (a plain
              sign-in, or one on the way to accepting an invitation),
              so nothing is lost by dropping the heading. */}
          <AltokiaLogo size={22} className="mx-auto mb-3 text-foreground" />
          <CardDescription className="text-muted-foreground">
            {inviteToken
              ? t('descAccept')
              : t('descWelcome')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            {revoked ? (
              <div
                role="alert"
                className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-500"
              >
                <p className="font-medium">{tAuth("accessRevoked.title")}</p>
                <p className="mt-1 opacity-90">{tAuth("accessRevoked.body")}</p>
              </div>
            ) : (
              error && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
                >
                  {error}
                </div>
              )
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                {t('emailLabel')}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t('emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-muted-foreground">
                  {t('passwordLabel')}
                </Label>
                <Link
                  href="/forgot-password"
                  className="text-sm text-primary hover:text-primary/80"
                >
                  {t('forgotPassword')}
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                placeholder={t('passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? t('signingIn') : t('signIn')}
            </Button>
          </form>

          {/* There is no self-service sign-up to link to. Altokia creates
              every login from the operator console and hands the customer
              their credentials, so a "create account" link would only lead
              to a form the Supabase project refuses outright. What a
              stranded visitor actually needs is to know where access comes
              from, so the footer says that instead of offering a door that
              isn't there. */}
          <p className="mt-6 text-center text-sm text-muted-foreground">
            {tAuth('login.noSelfSignup')}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
