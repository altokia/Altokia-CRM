'use client';

// ============================================================
// Provisioning a business, cold.
//
// The customer does not sign up. Altokia creates the login, sets the
// password and hands over credentials that already work — so this
// dialog asks for the person as well as the company, and produces a
// working account rather than an invitation to make one.
//
// Two faces. The first collects what the route needs; the second is
// the only time the password is ever visible, which is why the dialog
// says so in as many words instead of letting the operator find out
// later. Closing wipes both faces: the password exists in this
// component's state and nowhere else — not in storage, not in the
// URL, not in the audit log the route writes.
//
// DRESS ONLY. Same fields in the same order, same validation, same
// lifetime for the password in memory. What changed: Sora on the
// title, 11px corners and a hairline on the fields, the brand gradient
// on the one button that creates the account, the console's 10/14/18/26
// spacing — and the credentials face turned into the loudest block in
// the product, because it is the only screen where looking away costs
// a phone call to the customer.
// ============================================================

import { useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { CredentialsPanel } from './credentials-panel';
import { MIN_PASSWORD_LENGTH, PasswordField } from './password-field';
import { PlanIncludes, PlanSelect } from './plan-select';
import { usePlans } from './use-plans';
import {
  platformPost,
  PlatformRequestError,
  type CreateAccountResponse,
  type IssuedCredentials,
} from './platform-api';

/** The gradient the one creating button wears, and nothing else here. */
const BRAND_GRADIENT = 'var(--altokia-gradient)';

const PRIMARY_BUTTON =
  'h-10 gap-2 rounded-[var(--altokia-radius-md)] border-transparent px-4 text-sm font-semibold text-altokia-white shadow-altokia hover:opacity-90';

const SECONDARY_BUTTON =
  'h-10 rounded-[var(--altokia-radius-md)] border-border bg-card px-4 text-sm font-medium';

/** Dialog shell: 18px corners, hairline, the pop shadow. */
const DIALOG =
  'max-h-[85dvh] gap-[var(--altokia-space-3)] overflow-y-auto rounded-[var(--altokia-radius-xl)] border border-border p-[var(--altokia-space-3)] shadow-altokia-pop ring-0 sm:max-w-md';

/** Its footer, re-hung on the dialog's own 18px padding. */
const DIALOG_FOOTER =
  'mx-[calc(var(--altokia-space-3)*-1)] mb-[calc(var(--altokia-space-3)*-1)] gap-[var(--altokia-space-1)] rounded-b-[var(--altokia-radius-xl)] border-t border-border bg-card-2 p-[var(--altokia-space-3)]';

/** 11px corners, a hairline, and the console's 40px control height. */
const FIELD =
  'h-10 rounded-[var(--altokia-radius-md)] border-border bg-card-2 px-3.5 text-sm';
const FIELD_LABEL = 'text-[13px] font-medium text-muted-foreground';

/**
 * Two of the six controls in this form — the password box with its
 * "generate" button, and the plan dropdown — are shared components
 * this file does not own, and they come out of the primitives at 32px.
 * A form where four fields are 40px and two are not reads as broken,
 * so the height is imposed on the form as a whole from here. Geometry
 * only: nothing about what those components do or contain changes.
 */
const FORM_CONTROL_HEIGHT = '[&_input]:h-10! [&_button]:h-10!';

/**
 * The credentials face. The block itself is the shared CredentialsPanel
 * — the password reset shows the same one — so the emphasis is applied
 * from here rather than inside it: surface 2 under a warning border,
 * the data lines a size up in mono, and the "you will not see this
 * again" line in the warning tone rather than the danger one.
 *
 * Re-pointing --destructive for this subtree is what re-tones that
 * line: the panel styles it with the product token, so the token is
 * what changes, and nothing about the shared component moves.
 */
const CREDENTIALS_EMPHASIS = cn(
  'rounded-[var(--altokia-radius-lg)] border border-altokia-warning/[45%]',
  'bg-card-2 p-[var(--altokia-space-2)] shadow-altokia',
  '[&_p.font-mono]:text-[15px] [&_p.font-mono]:leading-[1.55]',
);

const CREDENTIALS_WARNING_TONE = {
  '--destructive': 'var(--altokia-warning-text)',
} as CSSProperties;

export function NewClientDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const t = useTranslations('Platform');
  const { selectable, find, loading } = usePlans();

  const [name, setName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [password, setPassword] = useState('');
  const [plan, setPlan] = useState<string | null>(null);
  const [timezone, setTimezone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [issued, setIssued] = useState<IssuedCredentials | null>(null);

  // An empty password is allowed: the route picks one and returns it,
  // and the panel shows whichever of the two the server settled on.
  const passwordOk =
    password.length === 0 || password.length >= MIN_PASSWORD_LENGTH;
  const ready =
    name.trim().length > 0 && ownerEmail.trim().length > 0 && passwordOk;

  function reset() {
    setName('');
    setOwnerEmail('');
    setOwnerName('');
    setPassword('');
    setPlan(null);
    setTimezone('');
    setSubmitting(false);
    setIssued(null);
  }

  async function submit() {
    if (!ready || submitting) return;
    setSubmitting(true);
    try {
      const data = await platformPost<CreateAccountResponse>(
        '/api/platform/accounts',
        {
          name: name.trim(),
          owner_email: ownerEmail.trim(),
          owner_name: ownerName.trim() || undefined,
          password: password || undefined,
          plan: plan ?? undefined,
          timezone: timezone.trim() || undefined,
        },
      );

      onCreated();

      if (data.credentials?.password) {
        // Everything the form held goes now; only `issued` survives,
        // and only until the dialog closes.
        setName('');
        setOwnerEmail('');
        setOwnerName('');
        setPassword('');
        setTimezone('');
        setIssued(data.credentials);
      } else {
        // The account exists but the response carried no password to
        // show. Saying nothing would be worse than saying so.
        toast.error(t('errors.generic'));
        reset();
        onOpenChange(false);
      }
    } catch (err) {
      console.error('[platform-console] create client failed:', err);
      const conflict =
        err instanceof PlatformRequestError && err.status === 409;
      toast.error(
        conflict
          ? t('new.emailTaken')
          : err instanceof Error
            ? err.message
            : t('errors.generic'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className={DIALOG}>
        <DialogHeader>
          <DialogTitle className="font-heading text-[17px] leading-tight font-bold tracking-tight">
            {t('new.title')}
          </DialogTitle>
          {issued ? (
            <DialogDescription className="text-[13px] leading-[1.55]">
              {t('new.done')}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {issued ? (
          <div
            className={CREDENTIALS_EMPHASIS}
            style={CREDENTIALS_WARNING_TONE}
          >
            <CredentialsPanel
              email={issued.email}
              password={issued.password}
              loginUrl={issued.login_url}
            />
          </div>
        ) : (
          <>
            <div
              className={cn(
                'space-y-[var(--altokia-space-3)]',
                FORM_CONTROL_HEIGHT,
              )}
            >
              <div className="space-y-[var(--altokia-space-1)]">
                <Label htmlFor="platform-new-name" className={FIELD_LABEL}>
                  {t('new.name')}
                </Label>
                <Input
                  id="platform-new-name"
                  value={name}
                  maxLength={120}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                  className={FIELD}
                />
              </div>

              <div className="space-y-[var(--altokia-space-1)]">
                <Label htmlFor="platform-new-email" className={FIELD_LABEL}>
                  {t('new.ownerEmail')}
                </Label>
                {/* The address is what the customer will type to sign
                    in, so it is mono like the password below it. */}
                <Input
                  id="platform-new-email"
                  type="email"
                  autoComplete="off"
                  value={ownerEmail}
                  onChange={(e) => setOwnerEmail(e.target.value)}
                  className={cn(FIELD, 'font-mono')}
                />
              </div>

              <div className="space-y-[var(--altokia-space-1)]">
                <Label
                  htmlFor="platform-new-owner-name"
                  className={FIELD_LABEL}
                >
                  {t('new.ownerName')}
                </Label>
                <Input
                  id="platform-new-owner-name"
                  value={ownerName}
                  maxLength={120}
                  autoComplete="off"
                  onChange={(e) => setOwnerName(e.target.value)}
                  className={FIELD}
                />
              </div>

              <PasswordField
                id="platform-new-password"
                value={password}
                onChange={setPassword}
              />

              <PlanSelect
                id="platform-new-plan"
                label={t('new.plan')}
                value={plan}
                plans={selectable}
                disabled={loading}
                onChange={setPlan}
              />

              <PlanIncludes
                plan={find(plan)}
                className="rounded-[var(--altokia-radius-md)] border border-border bg-card-2 px-3.5 py-3"
              />

              <div className="space-y-[var(--altokia-space-1)]">
                <Label htmlFor="platform-new-tz" className={FIELD_LABEL}>
                  {t('new.timezone')}
                </Label>
                {/* An IANA zone is an identifier, not prose. */}
                <Input
                  id="platform-new-tz"
                  value={timezone}
                  maxLength={60}
                  onChange={(e) => setTimezone(e.target.value)}
                  className={cn(FIELD, 'font-mono')}
                />
              </div>
            </div>

            <DialogFooter className={DIALOG_FOOTER}>
              <Button
                variant="outline"
                disabled={submitting}
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
                className={SECONDARY_BUTTON}
              >
                {t('actions.cancel')}
              </Button>
              <Button
                onClick={() => void submit()}
                disabled={!ready || submitting}
                className={PRIMARY_BUTTON}
                style={{ backgroundImage: BRAND_GRADIENT }}
              >
                {submitting ? (
                  <Loader2
                    size={18}
                    strokeWidth={1.75}
                    className="size-[18px] animate-spin"
                  />
                ) : null}
                {t('new.submit')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
