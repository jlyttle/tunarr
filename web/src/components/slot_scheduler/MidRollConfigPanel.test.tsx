import { renderWithProviders, screen } from '@/test/utils';
import { FormProvider, useForm } from 'react-hook-form';
import { describe, expect, test } from 'vitest';
import { MidRollConfigPanel } from './MidRollConfigPanel';

type TestValues = Record<string, unknown>;
let currentForm: ReturnType<typeof useForm<TestValues>>;

const Harness = ({ defaults }: { defaults?: TestValues }) => {
  const form = useForm<TestValues>({
    defaultValues: {
      midRoll: {
        breakRule: { type: 'fixed_interval', intervalMs: 1_800_000 },
        maxBreaks: 0,
        minProgramDurationMs: 0,
        tailBufferMs: 0,
        breakDurationMs: 180_000,
        strategy: 'eager',
        ...defaults,
      },
    },
  });
  currentForm = form;
  return (
    <FormProvider {...form}>
      <MidRollConfigPanel />
    </FormProvider>
  );
};

describe('MidRollConfigPanel', () => {
  test('split slot flex sets defaults and clears break durations', async () => {
    const { user } = renderWithProviders(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Split slot flex' }));

    expect(currentForm.getValues('midRoll.splitSlotFlex')).toEqual({
      tailShare: 0.25,
      minTailMs: 60_000,
      minBreakMs: 60_000,
    });
    expect(currentForm.getValues('midRoll.breakDurationMs')).toBeUndefined();
    expect(currentForm.getValues('midRoll.breakDurationMinMs')).toBeUndefined();
    expect(currentForm.getValues('midRoll.breakDurationMaxMs')).toBeUndefined();
    expect(screen.getByLabelText('Tail share (%)')).toHaveValue(25);
  });

  test('switching back to fixed clears split slot flex', async () => {
    const { user } = renderWithProviders(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Split slot flex' }));
    await user.click(screen.getByRole('button', { name: 'Fixed' }));

    expect(currentForm.getValues('midRoll.splitSlotFlex')).toBeUndefined();
    expect(currentForm.getValues('midRoll.breakDurationMs')).toBe(180_000);
  });

  test('detected breaks hide the interval fields', async () => {
    const { user } = renderWithProviders(<Harness />);
    expect(screen.getByLabelText('Break Interval (minutes)')).toBeVisible();

    await user.click(screen.getByRole('combobox'));
    await user.click(
      screen.getByRole('option', {
        name: 'Detected breaks (breakdetect markers)',
      }),
    );

    expect(currentForm.getValues('midRoll.breakRule')).toEqual({
      type: 'detected',
    });
    expect(
      screen.queryByLabelText('Break Interval (minutes)'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Episodes without imported markers play straight through.',
      ),
    ).toBeVisible();
  });

  test('placement fields write milliseconds', async () => {
    const { user } = renderWithProviders(<Harness />);

    await user.type(screen.getByLabelText('No break before (minutes)'), '5');
    await user.type(
      screen.getByLabelText('Minimum gap between breaks (minutes)'),
      '10',
    );

    expect(currentForm.getValues('midRoll.minFirstBreakMs')).toBe(300_000);
    expect(currentForm.getValues('midRoll.minBreakIntervalMs')).toBe(600_000);
  });
});
