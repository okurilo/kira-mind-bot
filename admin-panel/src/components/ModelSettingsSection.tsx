import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Grid,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SaveIcon from '@mui/icons-material/Save';
import { FieldInput } from './FieldInput';
import { fetchAiPreset, fetchConfig, fetchModelPresets, restartService, saveAiPreset, saveConfig } from '../api';
import {
  OPENAI_MODEL_FIELDS,
  OPENAI_MODEL_PRESETS,
  matchModelPreset,
  rawModelValueEquals,
  resolveOpenAIFieldDraftState,
} from '../openaiModelRegistry';
import type { AiModelRef, AiPresetConfig, AiPresetName, AiPresetResponse, ConfigResponse, ConfigSourceInfo, ModelPreset, ModelPresetResponse } from '../types';
import type { ConfigSectionHandle } from './ConfigSection';

interface Props {
  config: ConfigResponse;
  onUpdate: (cfg: ConfigResponse) => void;
  onToast: (message: string, severity: 'success' | 'error') => void;
}

function getEntryRawModelValue(entry?: ConfigResponse[string]): string | null {
  if (!entry) return null;
  if (entry.rawValue !== undefined) return entry.rawValue ?? null;
  return entry.value ?? '';
}

function getSourceLabel(source: 'env_file' | 'inherited_default_text' | 'system_default'): string {
  switch (source) {
    case 'env_file':
      return 'Задано в настройках окружения';
    case 'inherited_default_text':
      return 'Наследует базовую текстовую модель';
    case 'system_default':
      return 'Значение по умолчанию';
  }
}

function getProviderLabel(provider: string): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'deepseek':
      return 'DeepSeek';
    case 'gemini':
      return 'Gemini';
    default:
      return provider;
  }
}

function SourceInfo({ source }: { source?: ConfigSourceInfo }) {
  if (!source) return null;

  return (
    <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'rgba(15, 23, 42, 0.35)' }}>
      <Typography variant="caption" color="text.secondary" component="div">
        Источник: <b>{source.label}</b>
        {source.appliesImmediately != null ? ` · ${source.appliesImmediately ? 'применяется сразу' : 'может потребоваться рестарт'}` : ''}
      </Typography>
      {source.description && (
        <Typography variant="caption" color="text.secondary" component="div">
          {source.description}
        </Typography>
      )}
      {source.technicalPath && (
        <Typography variant="caption" color="text.disabled" component="details" sx={{ mt: 0.5 }}>
          <summary>Технические детали</summary>
          {source.technicalPath}
        </Typography>
      )}
    </Box>
  );
}

function getPresetById(presetId: string | null): ModelPreset | null {
  if (!presetId) return null;
  return OPENAI_MODEL_PRESETS.find((preset) => preset.id === presetId) ?? null;
}

export const ModelSettingsSection = forwardRef<ConfigSectionHandle, Props>(
  function ModelSettingsSection({ config, onUpdate, onToast }, ref) {
    const [localValues, setLocalValues] = useState<Record<string, string | null>>(() =>
      Object.fromEntries(OPENAI_MODEL_FIELDS.map((field) => [field.envKey, getEntryRawModelValue(config[field.envKey])]))
    );
    const [saving, setSaving] = useState(false);
    const [autoRestart, setAutoRestart] = useState(false);
    const [modelPresetData, setModelPresetData] = useState<ModelPresetResponse | null>(null);
    const [selectedPresetId, setSelectedPresetId] = useState<string>('');
    const [aiPresetData, setAiPresetData] = useState<AiPresetResponse | null>(null);
    const [selectedAiPreset, setSelectedAiPreset] = useState<AiPresetName>('gpt-balanced');
    const [savingAiPreset, setSavingAiPreset] = useState(false);

    useEffect(() => {
      let cancelled = false;

      fetchModelPresets()
        .then((response) => {
          if (cancelled) return;
          setModelPresetData(response);
          setSelectedPresetId(response.activePresetId ?? '');
        })
        .catch(() => {
          if (cancelled) return;
          setModelPresetData(null);
          setSelectedPresetId('');
        });

      fetchAiPreset()
        .then((response) => {
          if (cancelled) return;
          setAiPresetData(response);
          setSelectedAiPreset(response.activePresetName);
        })
        .catch(() => {
          if (cancelled) return;
          setAiPresetData(null);
        });

      return () => {
        cancelled = true;
      };
    }, [config]);

    useEffect(() => {
      setLocalValues(
        Object.fromEntries(OPENAI_MODEL_FIELDS.map((field) => [field.envKey, getEntryRawModelValue(config[field.envKey])]))
      );
    }, [config]);

    const activeAiPreset = useMemo(
      () => aiPresetData?.availablePresets.find((preset) => preset.name === selectedAiPreset) ?? null,
      [aiPresetData, selectedAiPreset]
    );
    const providerCounts = useMemo(() => {
      const counts: Record<string, number> = {};
      if (!activeAiPreset) return counts;
      for (const modelRef of Object.values(activeAiPreset.models) as AiModelRef[]) {
        counts[modelRef.provider] = (counts[modelRef.provider] ?? 0) + 1;
      }
      return counts;
    }, [activeAiPreset]);

    const currentPreset = useMemo(
      () => getPresetById(selectedPresetId || modelPresetData?.activePresetId || null),
      [modelPresetData?.activePresetId, selectedPresetId]
    );
    const localMatchedPresetId = useMemo(() => matchModelPreset(localValues), [localValues]);
    const hasUnsavedChanges = useMemo(
      () =>
        OPENAI_MODEL_FIELDS.some((field) =>
          !rawModelValueEquals(localValues[field.envKey], getEntryRawModelValue(config[field.envKey]))
        ),
      [config, localValues]
    );
    const statusLabel = hasUnsavedChanges
      ? localMatchedPresetId
        ? 'Черновик, не сохранён'
        : 'Custom'
      : modelPresetData?.activePresetId
        ? 'Активен'
        : 'Custom';

    useImperativeHandle(ref, () => ({
      getUpdates() {
        const updates: Record<string, string | null> = {};
        for (const field of OPENAI_MODEL_FIELDS) {
          const value = localValues[field.envKey] ?? null;
          const initialValue = getEntryRawModelValue(config[field.envKey]);
          if (rawModelValueEquals(value, initialValue)) continue;
          updates[field.envKey] = value;
        }
        return updates;
      },
    }));

    const handleChange = (key: string, value: string) => {
      setLocalValues((prev) => ({ ...prev, [key]: value }));
    };

    const handleAiPresetSave = async () => {
      setSavingAiPreset(true);
      try {
        const result = await saveAiPreset(selectedAiPreset);
        if (!result.success) {
          onToast(result.error || 'Ошибка сохранения AI preset', 'error');
          return;
        }
        const response = await fetchAiPreset();
        setAiPresetData(response);
        setSelectedAiPreset(response.activePresetName);
        onToast(result.message || '✅ AI preset сохранён', 'success');
      } catch {
        onToast('Ошибка соединения', 'error');
      } finally {
        setSavingAiPreset(false);
      }
    };

    const handlePresetChange = (presetId: string) => {
      setSelectedPresetId(presetId);
      const preset = getPresetById(presetId);
      if (!preset) return;

      setLocalValues((prev) => ({
        ...prev,
        ...preset.values,
      }));
    };

    const handleSave = async () => {
      setSaving(true);
      try {
        const updates: Record<string, string | null> = {};
        for (const field of OPENAI_MODEL_FIELDS) {
          const value = localValues[field.envKey] ?? null;
          const initialValue = getEntryRawModelValue(config[field.envKey]);
          if (rawModelValueEquals(value, initialValue)) continue;
          updates[field.envKey] = value;
        }

        const result = await saveConfig(updates);
        if (result.success) {
          if (autoRestart) {
            onToast('💾 Сохранено. Перезапускаю ботов...', 'success');
            await Promise.all([
              restartService('kira-mind-bot'),
              restartService('sergey-brain-bot'),
            ]);
            onToast('✅ Сохранено и боты перезапущены', 'success');
          } else {
            onToast(result.message || '✅ Сохранено', 'success');
          }

          const newCfg = await fetchConfig();
          onUpdate(newCfg);
        } else {
          onToast(result.error || 'Ошибка сохранения', 'error');
        }
      } catch {
        onToast('Ошибка соединения', 'error');
      } finally {
        setSaving(false);
      }
    };

    return (
      <Card id="model-presets" sx={{ mb: 2 }}>
        <CardHeader
          title="🧩 Model Presets"
          titleTypographyProps={{ variant: 'subtitle1', fontWeight: 600, color: 'secondary.main' }}
          action={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Tooltip title="Автоматически перезапустить ботов после сохранения">
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={autoRestart}
                      onChange={(e) => setAutoRestart(e.target.checked)}
                      sx={{ color: 'text.disabled', '&.Mui-checked': { color: 'primary.light' } }}
                    />
                  }
                  label={<span style={{ fontSize: 11, color: '#64748b' }}>рестарт</span>}
                  sx={{ mr: 0 }}
                />
              </Tooltip>
              <Button
                variant="outlined"
                size="small"
                startIcon={
                  saving ? (
                    <CircularProgress size={14} color="inherit" />
                  ) : autoRestart ? (
                    <RestartAltIcon fontSize="small" />
                  ) : (
                    <SaveIcon fontSize="small" />
                  )
                }
                onClick={handleSave}
                disabled={saving}
                sx={{
                  borderColor: 'divider',
                  color: 'text.secondary',
                  '&:hover': { borderColor: 'primary.main', color: 'primary.light' },
                }}
              >
                Сохранить
              </Button>
            </div>
          }
          sx={{ pb: 0 }}
        />
        <CardContent>
          <Stack spacing={2}>
            <Box sx={{ p: 2, border: '1px solid', borderColor: 'primary.dark', borderRadius: 1.5, bgcolor: 'rgba(37, 99, 235, 0.08)' }}>
              <Stack spacing={1.5}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', sm: 'center' }}>
                  <TextField
                    select
                    label="Активный AI preset"
                    value={selectedAiPreset}
                    onChange={(event) => setSelectedAiPreset(event.target.value as AiPresetName)}
                    helperText="Runtime-настройка хранится в БД и применяется без перезапуска."
                    sx={{ flex: 1 }}
                  >
                    {(aiPresetData?.availablePresets ?? []).map((preset: AiPresetConfig) => (
                      <MenuItem key={preset.name} value={preset.name}>
                        {preset.title}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Button
                    variant="contained"
                    onClick={handleAiPresetSave}
                    disabled={savingAiPreset || selectedAiPreset === aiPresetData?.activePresetName}
                    startIcon={savingAiPreset ? <CircularProgress size={14} color="inherit" /> : <SaveIcon fontSize="small" />}
                  >
                    Применить
                  </Button>
                </Stack>

                {activeAiPreset && (
                  <>
                    <Typography variant="body2" color="text.secondary">
                      {activeAiPreset.description}
                    </Typography>
                    <Stack direction="row" spacing={1} flexWrap="wrap">
                      <Chip size="small" color={selectedAiPreset === aiPresetData?.activePresetName ? 'success' : 'warning'} label={selectedAiPreset === aiPresetData?.activePresetName ? 'Активен' : 'Есть несохранённое изменение'} />
                      {Object.entries(providerCounts).map(([provider, count]) => (
                        <Chip key={provider} size="small" variant="outlined" label={`${getProviderLabel(provider)}: ${count}`} />
                      ))}
                    </Stack>
                    <Grid container spacing={1}>
                      {(['intentClassification', 'conversation', 'messageAnalysis', 'memoryConsolidation', 'webSearchReasoning', 'browserVision'] as const).map((taskKey) => {
                        const modelRef = activeAiPreset.models[taskKey];
                        if (!modelRef) return null;
                        return (
                          <Grid item xs={12} sm={6} md={4} key={taskKey}>
                            <Typography variant="caption" color="text.secondary" component="div">
                              {taskKey}: <b>{getProviderLabel(modelRef.provider)}</b> · {modelRef.model}
                            </Typography>
                          </Grid>
                        );
                      })}
                    </Grid>
                  </>
                )}
                <SourceInfo source={aiPresetData?.source} />
              </Stack>
            </Box>

            <Divider sx={{ borderColor: 'divider' }} />

            <Typography variant="subtitle2" color="text.secondary">
              Legacy GPT presets / низкоуровневые OpenAI overrides
            </Typography>
            <TextField
              select
              label="Legacy GPT preset"
              value={selectedPresetId}
              onChange={(event) => handlePresetChange(event.target.value)}
              SelectProps={{ displayEmpty: true }}
              helperText="Технические env-настройки OpenAI-only режима. Обычно менять не нужно; для применения может потребоваться рестарт."
            >
              {!selectedPresetId && (
                <MenuItem value="" disabled>
                  Custom
                </MenuItem>
              )}
              {OPENAI_MODEL_PRESETS.map((preset) => (
                <MenuItem key={preset.id} value={preset.id}>
                  {preset.title}
                </MenuItem>
              ))}
            </TextField>

            <Stack direction="row" spacing={1} flexWrap="wrap">
              <Chip size="small" label={statusLabel} color={statusLabel === 'Активен' ? 'success' : 'default'} />
              {currentPreset && (
                <>
                  <Chip size="small" label={currentPreset.qualityLabel} variant="outlined" />
                  <Chip size="small" label={currentPreset.costLabel} variant="outlined" />
                  <Chip size="small" label={currentPreset.riskLabel} variant="outlined" />
                </>
              )}
            </Stack>

            {currentPreset && (
              <Typography variant="caption" color="text.secondary">
                {currentPreset.description}
              </Typography>
            )}

            <SourceInfo source={modelPresetData?.source} />

            <Divider sx={{ borderColor: 'divider' }} />

            <Accordion disableGutters sx={{ bgcolor: 'transparent', boxShadow: 'none' }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="body2" fontWeight={600}>
                  Расширенные OpenAI overrides
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 0 }}>
                <Grid container spacing={2}>
                  {OPENAI_MODEL_FIELDS.map((field) => {
                    const draftState = resolveOpenAIFieldDraftState(field, localValues);
                    const fieldValue = localValues[field.envKey];
                    const isChangedFromPreset = currentPreset
                      ? !rawModelValueEquals(fieldValue, currentPreset.values[field.envKey] ?? null)
                      : false;

                    return (
                      <Grid item key={field.envKey} xs={12} sm={6}>
                        <Box>
                          <FieldInput
                            field={{
                              key: field.envKey,
                              label: field.label,
                              type: 'text',
                              hint: field.hint,
                              placeholder: field.placeholder,
                            }}
                            value={fieldValue ?? ''}
                            displayValue={draftState.value}
                            onChange={handleChange}
                          />
                          <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 1 }}>
                            <Chip
                              size="small"
                              label={getSourceLabel(draftState.source)}
                              variant="outlined"
                              sx={{ height: 22, fontSize: '11px' }}
                            />
                            {isChangedFromPreset && (
                              <Chip
                                size="small"
                                label="Изменено вручную"
                                color="warning"
                                variant="outlined"
                                sx={{ height: 22, fontSize: '11px' }}
                              />
                            )}
                          </Stack>
                        </Box>
                      </Grid>
                    );
                  })}
                </Grid>
              </AccordionDetails>
            </Accordion>
          </Stack>
        </CardContent>
      </Card>
    );
  }
);
