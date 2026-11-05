import type { MessageDescriptor } from '@lingui/core';
import { i18n } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Add } from '@mui/icons-material';
import {
  Box,
  Checkbox,
  Chip,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import type { MidRollConfig } from '@tunarr/types/api';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { Controller, useFormContext } from 'react-hook-form';

type MidRollBreakRuleFormFields = {
  type: 'fixed_interval' | 'percentage' | 'initial_then_interval' | 'detected';
  intervalMs?: number;
  points?: number[];
  initialDelayMs?: number;
};

type MidRollFormFields = {
  filler?: { types?: string[] }[];
  midRoll: {
    intervalMs?: number;
    breakRule?: MidRollBreakRuleFormFields;
    maxBreaks: number;
    minProgramDurationMs: number;
    tailBufferMs: number;
    breakDurationMs?: number;
    breakDurationMinMs?: number;
    breakDurationMaxMs?: number;
    splitSlotFlex?: {
      tailShare: number;
      minTailMs: number;
      minBreakMs: number;
    };
    minFirstBreakMs?: number;
    minBreakIntervalMs?: number;
    programTypes?: string[];
    strategy: 'eager' | 'lazy';
  };
};

const programTypeLabels: Record<
  NonNullable<MidRollConfig['programTypes']>[number],
  string
> = {
  movie: 'Movies',
  episode: 'Episodes',
  track: 'Music Tracks',
  music_video: 'Music Videos',
  other_video: 'Other Videos',
};

const allProgramTypes = Object.keys(programTypeLabels) as NonNullable<
  MidRollConfig['programTypes']
>;

const breakRuleLabels: Record<
  MidRollBreakRuleFormFields['type'],
  MessageDescriptor
> = {
  fixed_interval: msg`Fixed Interval`,
  percentage: msg`Percentage-Based`,
  initial_then_interval: msg`Initial Delay + Interval`,
  detected: msg`Detected breaks (breakdetect markers)`,
};

type DurationMode = 'fixed' | 'range' | 'split';

const defaultSplitSlotFlex = {
  tailShare: 0.25,
  minTailMs: 60_000,
  minBreakMs: 60_000,
};

function msToMinutes(ms: number): number {
  return Math.round(dayjs.duration(ms).asMinutes());
}

function minutesToMs(minutes: number): number {
  return dayjs.duration({ minutes }).asMilliseconds();
}

export const MidRollConfigPanel = () => {
  const { control, watch, setValue, getValues } =
    useFormContext<MidRollFormFields>();

  const breakRuleType = watch('midRoll.breakRule.type');
  const points = watch('midRoll.breakRule.points');
  const strategy = watch('midRoll.strategy');
  const hasMidFiller =
    watch('filler')?.some((f) => f.types?.includes('mid')) ?? false;

  const [newPoint, setNewPoint] = useState('');
  const [durationMode, setDurationMode] = useState<DurationMode>(() => {
    if (getValues('midRoll.splitSlotFlex') !== undefined) return 'split';
    return getValues('midRoll.breakDurationMinMs') !== undefined
      ? 'range'
      : 'fixed';
  });

  // Migrate V1 intervalMs to breakRule on mount
  useEffect(() => {
    const breakRule = getValues('midRoll.breakRule');
    const intervalMs = getValues('midRoll.intervalMs');
    if (!breakRule && intervalMs) {
      setValue('midRoll.breakRule', {
        type: 'fixed_interval',
        intervalMs,
      });
    }
  }, [getValues, setValue]);

  const handleBreakRuleTypeChange = (
    newType: MidRollBreakRuleFormFields['type'],
  ) => {
    switch (newType) {
      case 'fixed_interval':
        setValue('midRoll.breakRule', {
          type: 'fixed_interval',
          intervalMs: minutesToMs(30),
        });
        break;
      case 'percentage':
        setValue('midRoll.breakRule', {
          type: 'percentage',
          points: [50],
        });
        break;
      case 'initial_then_interval':
        setValue('midRoll.breakRule', {
          type: 'initial_then_interval',
          initialDelayMs: minutesToMs(15),
          intervalMs: minutesToMs(30),
        });
        break;
      case 'detected':
        setValue('midRoll.breakRule', { type: 'detected' });
        break;
    }
  };

  const handleAddPoint = () => {
    const value = Number(newPoint);
    if (isNaN(value) || value <= 0 || value >= 100) return;
    const current = points ?? [];
    if (current.includes(value)) return;
    setValue(
      'midRoll.breakRule.points',
      [...current, value].sort((a, b) => a - b),
    );
    setNewPoint('');
  };

  const handleRemovePoint = (value: number) => {
    const current = points ?? [];
    setValue(
      'midRoll.breakRule.points',
      current.filter((p) => p !== value),
    );
  };

  const handleDurationModeChange = (mode: DurationMode) => {
    setDurationMode(mode);
    setValue(
      'midRoll.breakDurationMs',
      mode === 'fixed' ? minutesToMs(3) : undefined,
    );
    setValue(
      'midRoll.breakDurationMinMs',
      mode === 'range' ? minutesToMs(2) : undefined,
    );
    setValue(
      'midRoll.breakDurationMaxMs',
      mode === 'range' ? minutesToMs(5) : undefined,
    );
    setValue(
      'midRoll.splitSlotFlex',
      mode === 'split' ? { ...defaultSplitSlotFlex } : undefined,
    );
  };

  return (
    <Stack spacing={2}>
      {!hasMidFiller && (
        <Typography variant="body2" color="text.secondary">
          <Trans>
            Without a Mid filler list, only the Detected rule adds breaks; they
            are filled from the channel's filler at play time.
          </Trans>
        </Typography>
      )}

      {/* Section 1: Break Positioning */}
      <Typography variant="subtitle2">
        <Trans>Break Positioning</Trans>
      </Typography>
      <Controller
        control={control}
        name="midRoll.breakRule.type"
        defaultValue="fixed_interval"
        render={({ field }) => (
          <FormControl fullWidth>
            <InputLabel>Break Rule</InputLabel>
            <Select
              label="Break Rule"
              value={breakRuleType ?? 'fixed_interval'}
              onChange={(e) => {
                const newType = e.target
                  .value as MidRollBreakRuleFormFields['type'];
                field.onChange(newType);
                handleBreakRuleTypeChange(newType);
              }}
            >
              {Object.entries(breakRuleLabels).map(([value, label]) => (
                <MenuItem key={value} value={value}>
                  {i18n.t(label)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
      />

      {breakRuleType === 'detected' && (
        <Typography variant="body2" color="text.secondary">
          <Trans>
            Episodes without imported markers play straight through.
          </Trans>
        </Typography>
      )}

      {breakRuleType === 'fixed_interval' && (
        <Controller
          control={control}
          name="midRoll.breakRule.intervalMs"
          render={({ field }) => (
            <TextField
              label={t`Break Interval (minutes)`}
              type="number"
              inputProps={{ min: 1 }}
              value={field.value !== undefined ? msToMinutes(field.value) : ''}
              onChange={(e) =>
                field.onChange(minutesToMs(Number(e.target.value)))
              }
              helperText={t`How often to insert a break`}
            />
          )}
        />
      )}

      {breakRuleType === 'percentage' && (
        <Stack spacing={1}>
          <Typography variant="body2" color="text.secondary">
            <Trans>
              Insert breaks at these percentages of the program duration
            </Trans>
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {(points ?? []).map((point) => (
              <Chip
                key={point}
                label={`${point}%`}
                onDelete={() => handleRemovePoint(point)}
              />
            ))}
          </Box>
          <Stack direction="row" spacing={1} alignItems="flex-start">
            <TextField
              label={t`Add point (%)`}
              type="number"
              inputProps={{ min: 1, max: 99 }}
              value={newPoint}
              onChange={(e) => setNewPoint(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddPoint();
                }
              }}
              size="small"
              sx={{ width: 140 }}
            />
            <IconButton
              onClick={handleAddPoint}
              disabled={
                newPoint === '' ||
                isNaN(Number(newPoint)) ||
                Number(newPoint) <= 0 ||
                Number(newPoint) >= 100 ||
                (points ?? []).includes(Number(newPoint))
              }
              color="primary"
            >
              <Add />
            </IconButton>
          </Stack>
        </Stack>
      )}

      {breakRuleType === 'initial_then_interval' && (
        <Stack direction="row" spacing={2}>
          <Controller
            control={control}
            name="midRoll.breakRule.initialDelayMs"
            render={({ field }) => (
              <TextField
                fullWidth
                label={t`Initial Delay (minutes)`}
                type="number"
                slotProps={{
                  htmlInput: { min: 1 },
                }}
                value={
                  field.value !== undefined ? msToMinutes(field.value) : ''
                }
                onChange={(e) =>
                  field.onChange(minutesToMs(Number(e.target.value)))
                }
                helperText={t`Time before first break`}
              />
            )}
          />
          <Controller
            control={control}
            name="midRoll.breakRule.intervalMs"
            render={({ field }) => (
              <TextField
                fullWidth
                label={t`Interval (minutes)`}
                type="number"
                inputProps={{ min: 1 }}
                value={
                  field.value !== undefined ? msToMinutes(field.value) : ''
                }
                onChange={(e) =>
                  field.onChange(minutesToMs(Number(e.target.value)))
                }
                helperText={t`Time between subsequent breaks`}
              />
            )}
          />
        </Stack>
      )}

      <Divider />

      {/* Section 2: Break Duration */}
      <Typography variant="subtitle2">
        <Trans>Break Duration</Trans>
      </Typography>
      <ToggleButtonGroup
        value={durationMode}
        exclusive
        onChange={(_, value) => {
          if (value) handleDurationModeChange(value as DurationMode);
        }}
        size="small"
      >
        <ToggleButton value="fixed">
          {' '}
          <Trans>Fixed</Trans>
        </ToggleButton>
        <ToggleButton value="range">
          <Trans>Range</Trans>
        </ToggleButton>
        <ToggleButton value="split">
          <Trans>Split slot flex</Trans>
        </ToggleButton>
      </ToggleButtonGroup>

      {durationMode === 'fixed' && (
        <Controller
          control={control}
          name="midRoll.breakDurationMs"
          render={({ field }) => (
            <TextField
              label={t`Break Duration (minutes)`}
              type="number"
              slotProps={{
                htmlInput: { min: 1 },
              }}
              value={field.value !== undefined ? msToMinutes(field.value) : ''}
              onChange={(e) =>
                field.onChange(minutesToMs(Number(e.target.value)))
              }
              helperText={t`How long each commercial break lasts`}
            />
          )}
        />
      )}

      {durationMode === 'range' && (
        <Stack direction="row" spacing={2}>
          <Controller
            control={control}
            name="midRoll.breakDurationMinMs"
            render={({ field }) => (
              <TextField
                fullWidth
                label={t`Min Duration (minutes)`}
                type="number"
                slotProps={{
                  htmlInput: { min: 1 },
                }}
                value={
                  field.value !== undefined ? msToMinutes(field.value) : ''
                }
                onChange={(e) =>
                  field.onChange(minutesToMs(Number(e.target.value)))
                }
              />
            )}
          />
          <Controller
            control={control}
            name="midRoll.breakDurationMaxMs"
            render={({ field }) => (
              <TextField
                fullWidth
                label={t`Max Duration (minutes)`}
                type="number"
                slotProps={{
                  htmlInput: { min: `` },
                }}
                value={
                  field.value !== undefined ? msToMinutes(field.value) : ''
                }
                onChange={(e) =>
                  field.onChange(minutesToMs(Number(e.target.value)))
                }
              />
            )}
          />
        </Stack>
      )}

      {durationMode === 'split' && (
        <Stack direction="row" spacing={2}>
          <Controller
            control={control}
            name="midRoll.splitSlotFlex.tailShare"
            render={({ field }) => (
              <TextField
                fullWidth
                label={t`Tail share (%)`}
                type="number"
                slotProps={{ htmlInput: { min: 0, max: 100 } }}
                value={
                  field.value !== undefined ? Math.round(field.value * 100) : ''
                }
                onChange={(e) => field.onChange(Number(e.target.value) / 100)}
                helperText={t`Share of the slot flex placed after the program`}
              />
            )}
          />
          <Controller
            control={control}
            name="midRoll.splitSlotFlex.minTailMs"
            render={({ field }) => (
              <TextField
                fullWidth
                label={t`Minimum tail (minutes)`}
                type="number"
                slotProps={{ htmlInput: { min: 0 } }}
                value={
                  field.value !== undefined ? msToMinutes(field.value) : ''
                }
                onChange={(e) =>
                  field.onChange(minutesToMs(Number(e.target.value)))
                }
                helperText={t`Smallest flex block kept after each program`}
              />
            )}
          />
          <Controller
            control={control}
            name="midRoll.splitSlotFlex.minBreakMs"
            render={({ field }) => (
              <TextField
                fullWidth
                label={t`Minimum break (minutes)`}
                type="number"
                slotProps={{ htmlInput: { min: 0 } }}
                value={
                  field.value !== undefined ? msToMinutes(field.value) : ''
                }
                onChange={(e) =>
                  field.onChange(minutesToMs(Number(e.target.value)))
                }
                helperText={t`Smallest flex block worth inserting as a break`}
              />
            )}
          />
        </Stack>
      )}

      <Divider />

      <Typography variant="subtitle2">Limits</Typography>
      <Controller
        control={control}
        name="midRoll.maxBreaks"
        render={({ field }) => (
          <TextField
            label="Max Breaks"
            type="number"
            slotProps={{
              htmlInput: { min: 0 },
            }}
            value={field.value}
            onChange={(e) => field.onChange(Number(e.target.value))}
            helperText={t`Maximum number of breaks per program (0 = unlimited)`}
          />
        )}
      />
      <Typography variant="subtitle2">
        <Trans>Placement</Trans>
      </Typography>
      <Controller
        control={control}
        name="midRoll.minFirstBreakMs"
        render={({ field }) => (
          <TextField
            label={t`No break before (minutes)`}
            type="number"
            slotProps={{ htmlInput: { min: 0 } }}
            value={field.value !== undefined ? msToMinutes(field.value) : ''}
            onChange={(e) =>
              field.onChange(
                e.target.value === ''
                  ? undefined
                  : minutesToMs(Number(e.target.value)),
              )
            }
            helperText={t`Keep the start of the program free of breaks`}
          />
        )}
      />
      <Controller
        control={control}
        name="midRoll.minBreakIntervalMs"
        render={({ field }) => (
          <TextField
            label={t`Minimum gap between breaks (minutes)`}
            type="number"
            slotProps={{ htmlInput: { min: 0 } }}
            value={field.value !== undefined ? msToMinutes(field.value) : ''}
            onChange={(e) =>
              field.onChange(
                e.target.value === ''
                  ? undefined
                  : minutesToMs(Number(e.target.value)),
              )
            }
            helperText={t`Drop breaks that fall closer together than this`}
          />
        )}
      />
      <Controller
        control={control}
        name="midRoll.minProgramDurationMs"
        render={({ field }) => (
          <TextField
            label={t`Minimum Program Duration (minutes)`}
            type="number"
            slotProps={{
              htmlInput: { min: 0 },
            }}
            value={msToMinutes(field.value)}
            onChange={(e) =>
              field.onChange(minutesToMs(Number(e.target.value)))
            }
            helperText={t`Skip mid-roll for programs shorter than this`}
          />
        )}
      />
      <Controller
        control={control}
        name="midRoll.tailBufferMs"
        render={({ field }) => (
          <TextField
            label={t`Tail Buffer (minutes)`}
            type="number"
            slotProps={{
              htmlInput: { min: 0 },
            }}
            value={msToMinutes(field.value ?? 0)}
            onChange={(e) =>
              field.onChange(minutesToMs(Number(e.target.value)))
            }
            helperText={`Skip breaks when less than this much content remains`}
          />
        )}
      />

      <Divider />

      <Typography variant="subtitle2">
        <Trans> Scheduling Strategy</Trans>
      </Typography>
      <Controller
        control={control}
        name="midRoll.strategy"
        render={({ field }) => (
          <Stack spacing={0.5}>
            <ToggleButtonGroup
              value={field.value ?? 'eager'}
              exclusive
              onChange={(_, value) => {
                if (value) field.onChange(value);
              }}
              size="small"
            >
              <ToggleButton value="eager">
                <Trans>Eager</Trans>
              </ToggleButton>
              <ToggleButton value="lazy">
                <Trans>Lazy</Trans>
              </ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary">
              {(strategy ?? 'eager') === 'eager'
                ? t`Filler is resolved at schedule time. The guide shows specific filler titles.`
                : t`Filler is picked fresh at stream time like Flex time. The guide shows "Commercial Break" placeholders.`}
            </Typography>
          </Stack>
        )}
      />

      <Controller
        control={control}
        name="midRoll.programTypes"
        render={({ field }) => {
          const selectedTypes = field.value ?? [];
          const handleChange = (
            type: (typeof allProgramTypes)[number],
            checked: boolean,
          ) => {
            if (checked) {
              field.onChange([...selectedTypes, type]);
            } else {
              field.onChange(selectedTypes.filter((t) => t !== type));
            }
          };
          return (
            <FormControl component="fieldset">
              <Typography variant="subtitle2">
                <Trans>Apply to Program Types (empty = all)</Trans>
              </Typography>
              <FormGroup row>
                {allProgramTypes.map((type) => (
                  <FormControlLabel
                    key={type}
                    control={
                      <Checkbox
                        checked={selectedTypes.includes(type)}
                        onChange={(e) => handleChange(type, e.target.checked)}
                      />
                    }
                    label={programTypeLabels[type]}
                  />
                ))}
              </FormGroup>
            </FormControl>
          );
        }}
      />
    </Stack>
  );
};
