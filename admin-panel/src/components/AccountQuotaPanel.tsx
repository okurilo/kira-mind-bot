import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import type { QuotaView } from '../../../platform/publicAccounts/contracts';
import { fetchAccountQuota } from '../api';

export function AccountQuotaPanel({ onQuota }: { onQuota?: (quota: QuotaView | null) => void }) {
  const [quota, setQuota] = useState<QuotaView | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [available, setAvailable] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const result = await fetchAccountQuota();
      setAvailable(result.available); setQuota(result.quota ?? null); onQuota?.(result.quota ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить квоты'); setQuota(null); onQuota?.(null); }
    finally { setLoading(false); }
  }, [onQuota]);
  useEffect(() => { void load(); }, [load]);
  return <Box component="section" aria-labelledby="account-quotas-title" sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2 }}>
    <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
      <Typography component="h3" variant="subtitle2" id="account-quotas-title">Квоты AI на сегодня</Typography>
      <Button size="small" onClick={() => void load()} disabled={loading} aria-label="Обновить квоты">Обновить</Button>
    </Stack>
    {loading ? <CircularProgress size={20} aria-label="Загрузка квот" /> : error ? <Alert severity="error">{error}</Alert>
      : !available ? <Typography variant="body2" color="text.secondary">В этой установке нет центральных квот аккаунта.</Typography>
      : quota && <>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ my: 1.5 }}>
          {([{ key: 'dialogue', title: 'Общение и поручения' }, { key: 'background', title: 'Фоновая работа' }, { key: 'images', title: 'Изображения' }] as const).map(({ key, title }) => {
            const value = quota[key];
            return <Box key={key} sx={{ flex: 1, minWidth: 0 }} data-quota={key}>
              <Typography variant="body2" fontWeight={600}>{title}</Typography>
              <Typography variant="h6" component="p">Осталось {value.remaining} из {value.limit}</Typography>
              <Typography variant="caption" color="text.secondary">Использовано {value.used}{value.reserved > 0 ? ` · В работе ${value.reserved}` : ''}</Typography>
              {value.remaining === 0 && <Typography variant="caption" color="warning.main" display="block">
                {key === 'background' ? 'Новые фоновые задачи на паузе' : 'Лимит новых задач исчерпан'}
              </Typography>}
            </Box>;
          })}
        </Stack>
        <Typography variant="caption" display="block" color="text.secondary">Фон не расходует квоту общения. Одна задача может включать несколько AI-вызовов.</Typography>
        <Typography variant="caption" display="block" color="text.secondary">Обновление: {new Date(quota.resetAt).toLocaleString('ru-RU')}</Typography>
        {(quota.legacyAi?.used > 0 || quota.legacyAi?.reserved > 0) && <Typography variant="caption" display="block" color="text.secondary">
          До разделения учтено {quota.legacyAi.used} операций; они сохранены отдельно и не уменьшают новые квоты.
        </Typography>}
      </>}
  </Box>;
}
