'use client';

// ============================================================
// Picking a tier, and seeing what the tier means.
//
// Before migration 050 the plan was a text box, so "Premium",
// "premium" and "premiun" were three plans and none of them said what
// the customer had bought. It is a dropdown over the catalogue now,
// and it never appears without the contents of the chosen tier beside
// it: the operator changing somebody's plan is deciding what that
// business is allowed to do, and that has to be legible at the moment
// of the decision rather than in a price list somewhere else.
//
// A limit the catalogue does not state is "Sin límite", never 0. The
// two are opposites and jsonb has no key for "no ceiling" other than
// the absence of one.
// ============================================================

import { useFormatter, useTranslations } from 'next-intl';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  PLAN_LIMIT_KEYS,
  planLimit,
  type PlanLimitKey,
  type PlatformPlan,
} from './platform-api';

/** base-ui needs a real value for the empty choice. */
const NO_PLAN = '__none__';

export function PlanSelect({
  id,
  label,
  value,
  plans,
  disabled,
  onChange,
}: {
  id: string;
  /** Supplied translated — "Plan" when creating, "Cambiar plan" later. */
  label: string;
  value: string | null;
  /** The assignable tiers, in catalogue order. */
  plans: PlatformPlan[];
  disabled?: boolean;
  onChange: (code: string | null) => void;
}) {
  const t = useTranslations('Platform');

  // A client already sitting on a retired tier keeps it in the list;
  // dropping it would silently rewrite their plan on the next save.
  const selected = plans.find((plan) => plan.code === value) ?? null;
  const orphanCode = value !== null && selected === null ? value : null;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value ?? NO_PLAN}
        disabled={disabled}
        onValueChange={(next) => {
          if (typeof next !== 'string') return;
          onChange(next === NO_PLAN ? null : next);
        }}
      >
        <SelectTrigger id={id} className="w-full sm:max-w-xs">
          <SelectValue>
            {selected?.name ?? orphanCode ?? t('plan.none')}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_PLAN}>{t('plan.none')}</SelectItem>
          {orphanCode ? (
            <SelectItem value={orphanCode}>{orphanCode}</SelectItem>
          ) : null}
          {plans.map((plan) => (
            <SelectItem key={plan.code} value={plan.code}>
              {plan.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * What the chosen tier includes. `usage` is optional and partial: a
 * line shows "3.000 de 10.000" only where the console actually knows
 * the consumption, and the bare ceiling everywhere else.
 */
export function PlanIncludes({
  plan,
  usage,
  className,
}: {
  plan: PlatformPlan | null;
  usage?: Partial<Record<PlanLimitKey, number | null | undefined>>;
  className?: string;
}) {
  const t = useTranslations('Platform');
  const tLimits = useTranslations('Platform.plan.limits');
  const format = useFormatter();

  if (!plan) return null;

  return (
    <div className={cn('rounded-lg bg-card-2 px-3 py-2.5', className)}>
      <p className="text-xs font-medium text-muted-foreground">
        {t('plan.includes')}
      </p>

      {plan.description ? (
        <p className="mt-1 text-xs text-muted-foreground">{plan.description}</p>
      ) : null}

      <dl className="mt-2 space-y-1">
        {PLAN_LIMIT_KEYS.map((key) => {
          const limit = planLimit(plan.limits, key);
          const used = usage?.[key];

          const value =
            limit === null
              ? t('plan.unlimited')
              : typeof used === 'number'
                ? t('plan.usage', {
                    used: format.number(used),
                    limit: format.number(limit),
                  })
                : format.number(limit);

          return (
            <div
              key={key}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <dt className="text-muted-foreground">{tLimits(key)}</dt>
              <dd
                className={cn(
                  'shrink-0 tabular-nums',
                  limit === null && 'text-muted-foreground',
                )}
              >
                {value}
              </dd>
            </div>
          );
        })}
      </dl>

      {plan.price_note ? (
        <p className="mt-2 text-xs text-muted-foreground">{plan.price_note}</p>
      ) : null}
    </div>
  );
}
