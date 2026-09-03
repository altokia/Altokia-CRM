'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Bell, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * One line → one FOLLOW_UP task. "mañana a las 10 llamar a Juan" is
 * parsed on the server in the account's time zone; the toast repeats
 * the moment back so a misread is caught immediately.
 */
export function FollowUpInput({
  contactId,
  conversationId,
  compact,
  onCreated,
}: {
  contactId?: string;
  conversationId?: string;
  compact?: boolean;
  onCreated?: () => void;
}) {
  const t = useTranslations('FollowUp');
  const format = useFormatter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/tasks/quick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: value,
          contact_id: contactId ?? null,
          conversation_id: conversationId ?? null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.code === 'no_date' ? t('noDate') : json.error || t('error'));
        return;
      }
      toast.success(
        t('created', {
          when: format.dateTime(new Date(json.due_at), {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          }),
        }),
      );
      setText('');
      onCreated?.();
    } catch {
      toast.error(t('error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={compact ? 'flex gap-1' : 'flex gap-2'}>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('placeholder')}
        disabled={busy}
        aria-label={t('title')}
        className={compact ? 'h-8 text-xs' : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      <Button
        type="button"
        size={compact ? 'sm' : 'default'}
        variant="outline"
        onClick={submit}
        disabled={busy || !text.trim()}
        title={t('button')}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Bell className="size-4" />}
        {!compact && t('button')}
      </Button>
    </div>
  );
}
